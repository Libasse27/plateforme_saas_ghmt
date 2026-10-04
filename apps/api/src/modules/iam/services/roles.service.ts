import { Injectable } from '@nestjs/common';
import type { CreateRoleInput, UpdateRoleInput } from '@ghmt/shared';
import { AuditService } from '../../../common/audit/audit.service';
import { RequestContext } from '../../../common/context/request-context';
import { DomainError } from '../../../common/errors/domain-error';
import { TenantDb, type TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { ROLE_SELECT, toRoleDetailDto, toRoleDto } from '../mappers/iam.mappers';
import { assertNoEscalation } from './privilege';

export interface PermissionDto {
  readonly code: string;
  readonly resource: string;
  readonly action: string;
  readonly isSensitive: boolean;
}
export interface PermissionGroupDto {
  readonly module: string;
  readonly name: string;
  readonly permissions: readonly PermissionDto[];
}

@Injectable()
export class RolesService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
    private readonly context: RequestContext,
  ) {}

  async list() {
    const rows = await this.tenantDb.run((tx) =>
      tx.role.findMany({ where: { deletedAt: null }, select: ROLE_SELECT, orderBy: [{ isSystem: 'desc' }, { code: 'asc' }] }),
    );
    return rows.map(toRoleDto);
  }

  async get(id: string) {
    return this.tenantDb.run(async (tx) => toRoleDetailDto(await this.requireRole(tx, id)));
  }

  /** Catalogue de permissions groupé par module (platform.permissions, lecture seule). */
  async permissionCatalog(): Promise<PermissionGroupDto[]> {
    const rows = await this.tenantDb.run((tx) =>
      tx.permission.findMany({
        select: { code: true, resource: true, action: true, isSensitive: true, module: { select: { code: true, name: true } } },
        orderBy: { code: 'asc' },
      }),
    );
    const groups = new Map<string, { name: string; permissions: PermissionDto[] }>();
    for (const row of rows) {
      const group = groups.get(row.module.code) ?? { name: row.module.name, permissions: [] };
      group.permissions.push({ code: row.code, resource: row.resource, action: row.action, isSensitive: row.isSensitive });
      groups.set(row.module.code, group);
    }
    return [...groups.entries()].map(([module, group]) => ({ module, name: group.name, permissions: group.permissions }));
  }

  async create(input: CreateRoleInput) {
    const principal = this.context.requirePrincipal();
    assertNoEscalation(this.context.grants, input.permissions);
    return this.tenantDb.run(async (tx) => {
      const existing = await tx.role.findFirst({ where: { code: input.code }, select: { id: true } });
      if (existing) throw DomainError.conflict('role_code_conflict', 'Ce code de rôle est déjà utilisé.');

      const role = await tx.role.create({
        data: {
          tenantId: principal.tenantId,
          code: input.code,
          name: input.name,
          description: input.description ?? null,
          createdBy: principal.userId,
        },
        select: { id: true },
      });
      await this.replacePermissions(tx, principal.tenantId, role.id, input.permissions);
      await this.audit.record(tx, principal.tenantId, {
        action: 'iam.role.created',
        resourceType: 'role',
        resourceId: role.id,
        changes: { after: { code: input.code, name: input.name, permissions: input.permissions } },
      });
      return toRoleDetailDto(await this.requireRole(tx, role.id));
    });
  }

  async update(id: string, input: UpdateRoleInput) {
    const principal = this.context.requirePrincipal();
    return this.tenantDb.run(async (tx) => {
      const before = await this.requireRole(tx, id);
      if (before.isSystem) throw DomainError.conflict('system_role_immutable', 'Un rôle système n’est pas modifiable.');

      const currentPermissions = before.permissions.map((p) => p.permissionCode);
      // L'acteur doit détenir les droits actuels (sinon il pourrait en priver un rôle puissant) et les nouveaux.
      assertNoEscalation(this.context.grants, [...currentPermissions, ...(input.permissions ?? [])]);

      await tx.role.update({
        where: { tenantId_id: { tenantId: principal.tenantId, id } },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          updatedBy: principal.userId,
        },
      });
      if (input.permissions) await this.replacePermissions(tx, principal.tenantId, id, input.permissions);

      await this.audit.record(tx, principal.tenantId, {
        action: 'iam.role.updated',
        resourceType: 'role',
        resourceId: id,
        changes: {
          before: { name: before.name, description: before.description, permissions: currentPermissions },
          after: {
            name: input.name ?? before.name,
            description: input.description ?? before.description,
            permissions: input.permissions ?? currentPermissions,
          },
        },
      });
      return toRoleDetailDto(await this.requireRole(tx, id));
    });
  }

  async remove(id: string): Promise<void> {
    const principal = this.context.requirePrincipal();
    await this.tenantDb.run(async (tx) => {
      const role = await this.requireRole(tx, id);
      if (role.isSystem) throw DomainError.conflict('system_role_immutable', 'Un rôle système ne peut pas être supprimé.');
      const inUse = await tx.userRoleAssignment.count({ where: { roleId: id, revokedAt: null } });
      if (inUse > 0) throw DomainError.conflict('role_in_use', 'Ce rôle est affecté à des utilisateurs : retirez d’abord ces affectations.');

      await tx.role.update({
        where: { tenantId_id: { tenantId: principal.tenantId, id } },
        data: { deletedAt: new Date(), updatedBy: principal.userId },
      });
      await this.audit.record(tx, principal.tenantId, {
        action: 'iam.role.deleted',
        resourceType: 'role',
        resourceId: id,
        changes: { before: { code: role.code, name: role.name } },
      });
    });
  }

  private async replacePermissions(tx: TenantTx, tenantId: string, roleId: string, permissions: readonly string[]): Promise<void> {
    await tx.rolePermission.deleteMany({ where: { roleId } });
    await tx.rolePermission.createMany({ data: permissions.map((permissionCode) => ({ tenantId, roleId, permissionCode })) });
  }

  private async requireRole(tx: TenantTx, id: string) {
    const role = await tx.role.findFirst({ where: { id, deletedAt: null }, select: ROLE_SELECT });
    if (!role) throw DomainError.notFound('Rôle');
    return role;
  }
}
