import { Injectable } from '@nestjs/common';
import type { CreateAssignmentInput } from '@ghmt/shared';
import { AuditService } from '../../../common/audit/audit.service';
import { RequestContext } from '../../../common/context/request-context';
import { DomainError } from '../../../common/errors/domain-error';
import { TenantDb, type TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { ASSIGNMENT_SELECT, toAssignmentDto, type AssignmentRow } from '../mappers/iam.mappers';
import { assertAnotherActiveAdmin } from './admin-invariant';
import { TENANT_ADMIN_ROLE } from '../../../infrastructure/tenancy/tenant-provisioning.service';
import { assertCanAssign, isSensitiveRole, type TargetScope } from './privilege';

@Injectable()
export class AssignmentsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
    private readonly context: RequestContext,
  ) {}

  async list(userId: string) {
    return this.tenantDb.run(async (tx) => {
      await this.requireUser(tx, userId);
      const rows = await tx.userRoleAssignment.findMany({
        where: { userId, revokedAt: null },
        select: ASSIGNMENT_SELECT,
        orderBy: { id: 'asc' },
      });
      return rows.map(toAssignmentDto);
    });
  }

  async create(userId: string, input: CreateAssignmentInput) {
    const principal = this.context.requirePrincipal();
    return this.tenantDb.run(async (tx) => {
      await this.requireUser(tx, userId);
      const row = await this.createInTx(tx, principal.tenantId, userId, input);
      return toAssignmentDto(row);
    });
  }

  async revoke(userId: string, assignmentId: string): Promise<void> {
    const principal = this.context.requirePrincipal();
    await this.tenantDb.run(async (tx) => {
      await this.requireUser(tx, userId);
      const assignment = await tx.userRoleAssignment.findFirst({
        where: { id: assignmentId, userId, revokedAt: null },
        select: {
          id: true,
          roleId: true,
          scopeType: true,
          scopeId: true,
          role: { select: { code: true, isSystem: true, permissions: { select: { permissionCode: true } } } },
        },
      });
      if (!assignment) throw DomainError.notFound('Affectation');

      const target = await this.resolveScope(tx, assignment.scopeType, assignment.scopeId ?? undefined, false);
      assertCanAssign(
        this.context.grants,
        { isSystem: assignment.role.isSystem, permissions: assignment.role.permissions.map((p) => p.permissionCode) },
        target,
        { actorUserId: principal.userId, targetUserId: userId, assignmentPermission: 'iam:assignment:delete' },
      );
      if (assignment.role.code === TENANT_ADMIN_ROLE && assignment.scopeType === 'tenant') {
        await assertAnotherActiveAdmin(tx, principal.tenantId, { excludeAssignmentId: assignment.id });
      }
      await tx.userRoleAssignment.update({
        where: { tenantId_id: { tenantId: principal.tenantId, id: assignment.id } },
        data: { revokedAt: new Date() },
      });
      await this.audit.record(tx, principal.tenantId, {
        action: 'iam.assignment.revoked',
        resourceType: 'user_role_assignment',
        resourceId: assignment.id,
        changes: {
          userId,
          before: { roleId: assignment.roleId, roleCode: assignment.role.code, scopeType: assignment.scopeType, scopeId: assignment.scopeId },
          after: { revoked: true },
        },
      });
    });
  }

  /** Création dans la transaction de l'appelant (aussi utilisée à la création d'un utilisateur). */
  async createInTx(tx: TenantTx, tenantId: string, userId: string, input: CreateAssignmentInput): Promise<AssignmentRow> {
    const role = await tx.role.findFirst({
      where: { id: input.roleId, deletedAt: null },
      select: { id: true, code: true, isSystem: true, permissions: { select: { permissionCode: true } } },
    });
    if (!role) throw DomainError.unprocessable('role_not_found', 'Le rôle indiqué est introuvable.');

    const target = await this.resolveScope(tx, input.scopeType, input.scopeId);
    assertCanAssign(
      this.context.grants,
      { isSystem: role.isSystem, permissions: role.permissions.map((p) => p.permissionCode) },
      target,
      { actorUserId: this.context.requirePrincipal().userId, targetUserId: userId, assignmentPermission: 'iam:assignment:create' },
    );

    const validUntil = input.validUntil ? new Date(input.validUntil) : null;
    if (validUntil && validUntil <= new Date()) {
      throw DomainError.unprocessable('invalid_validity', 'La date de fin de validité doit être dans le futur.');
    }
    const duplicate = await tx.userRoleAssignment.findFirst({
      where: { userId, roleId: role.id, scopeType: input.scopeType, scopeId: input.scopeId ?? null, revokedAt: null },
      select: { id: true },
    });
    if (duplicate) throw DomainError.conflict('assignment_exists', 'Cette affectation existe déjà pour l’utilisateur.');

    const created = await tx.userRoleAssignment.create({
      data: {
        tenantId,
        userId,
        roleId: role.id,
        scopeType: input.scopeType,
        scopeId: input.scopeId ?? null,
        validUntil,
        createdBy: this.context.requirePrincipal().userId,
      },
      select: ASSIGNMENT_SELECT,
    });
    await this.audit.record(tx, tenantId, {
      action: 'iam.assignment.created',
      resourceType: 'user_role_assignment',
      resourceId: created.id,
      changes: {
        userId,
        after: { roleId: role.id, roleCode: role.code, scopeType: input.scopeType, scopeId: input.scopeId ?? null, validUntil: input.validUntil ?? null },
      },
    });
    if (isSensitiveRole(role.permissions.map((p) => p.permissionCode))) {
      // Détection (risque résiduel H2) : toute affectation d'un rôle clinique ou financier est tracée à part.
      await this.audit.record(tx, tenantId, {
        action: 'iam.role.sensitive_assigned',
        resourceType: 'user_role_assignment',
        resourceId: created.id,
        changes: { userId, roleId: role.id, roleCode: role.code, scopeType: input.scopeType, scopeId: input.scopeId ?? null },
      });
    }
    return created;
  }

  /** Vérifie que le site / service visé existe dans le tenant (RLS) et renvoie la portée résolue. */
  private async resolveScope(tx: TenantTx, scopeType: string, scopeId: string | undefined, mustExist = true): Promise<TargetScope> {
    if (scopeType === 'tenant') return { type: 'tenant' };
    if (scopeType === 'site') {
      const site = scopeId ? await tx.site.findFirst({ where: { id: scopeId, deletedAt: null }, select: { id: true } }) : null;
      if (!site && !mustExist) return { type: 'site', id: scopeId };
      if (!site) throw DomainError.unprocessable('scope_not_found', 'Le site visé par la portée est introuvable.');
      return { type: 'site', id: site.id };
    }
    const department = scopeId
      ? await tx.department.findFirst({ where: { id: scopeId, deletedAt: null }, select: { id: true, siteId: true } })
      : null;
    if (!department && !mustExist) return { type: 'department', id: scopeId };
    if (!department) throw DomainError.unprocessable('scope_not_found', 'Le service visé par la portée est introuvable.');
    return { type: 'department', id: department.id, siteId: department.siteId };
  }

  private async requireUser(tx: TenantTx, userId: string): Promise<void> {
    const user = await tx.user.findFirst({ where: { id: userId, deletedAt: null }, select: { id: true } });
    if (!user) throw DomainError.notFound('Utilisateur');
  }
}
