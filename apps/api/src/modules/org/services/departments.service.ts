import { Injectable } from '@nestjs/common';
import { AuditService } from '../../../common/audit/audit.service';
import { scopesFor } from '../../../common/authz/authorization.service';
import { RequestContext } from '../../../common/context/request-context';
import { DomainError } from '../../../common/errors/domain-error';
import { TenantDb, type TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { DEPARTMENT_SELECT, toDepartmentDto } from '../mappers/org.mappers';
import { canAccessDepartment, canAccessSite, departmentScopeWhere, diffChanges } from './org-scope';
import type { CreateDepartmentInput, UpdateDepartmentInput } from './org.types';

type WritePermission = 'org:service:update' | 'org:service:delete';
const MAX_HIERARCHY_DEPTH = 50;

@Injectable()
export class DepartmentsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
    private readonly context: RequestContext,
  ) {}

  async list(siteId?: string) {
    const scopes = scopesFor('org:service:read', this.context.grants);
    const rows = await this.tenantDb.run((tx) =>
      tx.department.findMany({
        where: { deletedAt: null, ...(siteId ? { siteId } : {}), ...departmentScopeWhere(scopes) },
        select: DEPARTMENT_SELECT,
        orderBy: [{ siteId: 'asc' }, { code: 'asc' }],
      }),
    );
    return rows.map(toDepartmentDto);
  }

  async get(id: string) {
    const scopes = scopesFor('org:service:read', this.context.grants);
    return this.tenantDb.run(async (tx) => {
      const department = await this.requireDepartment(tx, id);
      if (!canAccessDepartment(scopes, department)) throw DomainError.notFound('Service');
      return toDepartmentDto(department);
    });
  }

  async create(input: CreateDepartmentInput) {
    const principal = this.context.requirePrincipal();
    return this.tenantDb.run(async (tx) => {
      const site = await tx.site.findFirst({ where: { id: input.siteId, deletedAt: null }, select: { id: true } });
      if (!site) throw DomainError.unprocessable('site_not_found', 'Le site indiqué est introuvable.');
      if (!canAccessSite(scopesFor('org:service:create', this.context.grants), site.id)) {
        throw DomainError.forbidden('out_of_scope', 'Ce site est hors de votre portée.', 'org:service:create');
      }
      await this.assertCodeFree(tx, input.siteId, input.code);
      if (input.parentId) await this.assertValidParent(tx, input.siteId, input.parentId);

      const department = await tx.department.create({
        data: { ...input, tenantId: principal.tenantId, createdBy: principal.userId },
        select: DEPARTMENT_SELECT,
      });
      await this.audit.record(tx, principal.tenantId, {
        action: 'org.department.created',
        resourceType: 'department',
        resourceId: department.id,
        changes: { after: { siteId: department.siteId, parentId: department.parentId, code: department.code, name: department.name, kind: department.kind } },
      });
      return toDepartmentDto(department);
    });
  }

  async update(id: string, input: UpdateDepartmentInput) {
    const principal = this.context.requirePrincipal();
    return this.tenantDb.run(async (tx) => {
      const current = await this.requireDepartment(tx, id);
      this.assertWritable('org:service:update', current);
      if (input.code !== undefined && input.code !== current.code) await this.assertCodeFree(tx, current.siteId, input.code, id);
      if (input.parentId !== undefined && input.parentId !== current.parentId) {
        await this.assertValidParent(tx, current.siteId, input.parentId, id);
      }
      const updated = await tx.department.update({
        where: { tenantId_id: { tenantId: principal.tenantId, id } },
        data: { ...input, updatedBy: principal.userId, rowVersion: { increment: 1 } },
        select: DEPARTMENT_SELECT,
      });
      await this.audit.record(tx, principal.tenantId, {
        action: 'org.department.updated',
        resourceType: 'department',
        resourceId: id,
        changes: diffChanges(current, input),
      });
      return toDepartmentDto(updated);
    });
  }

  async remove(id: string): Promise<void> {
    const principal = this.context.requirePrincipal();
    await this.tenantDb.run(async (tx) => {
      const department = await this.requireDepartment(tx, id);
      this.assertWritable('org:service:delete', department);
      const children = await tx.department.count({ where: { parentId: id, deletedAt: null } });
      if (children > 0) throw DomainError.conflict('department_has_children', 'Ce service a des sous-services actifs : supprimez-les d’abord.');

      await tx.department.update({
        where: { tenantId_id: { tenantId: principal.tenantId, id } },
        data: { deletedAt: new Date(), updatedBy: principal.userId, rowVersion: { increment: 1 } },
      });
      await this.audit.record(tx, principal.tenantId, {
        action: 'org.department.deleted',
        resourceType: 'department',
        resourceId: id,
        changes: { before: { siteId: department.siteId, code: department.code, name: department.name } },
      });
    });
  }

  private assertWritable(permission: WritePermission, department: { id: string; siteId: string }): void {
    if (!canAccessDepartment(scopesFor(permission, this.context.grants), department)) {
      throw DomainError.forbidden('out_of_scope', 'Ce service est hors de votre portée.', permission);
    }
  }

  private async assertCodeFree(tx: TenantTx, siteId: string, code: string, excludeId?: string): Promise<void> {
    const existing = await tx.department.findFirst({
      where: { siteId, code, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { id: true },
    });
    if (existing) throw DomainError.conflict('department_code_conflict', 'Ce code de service est déjà utilisé sur ce site.');
  }

  /** Le parent doit être un service actif du même site, sans créer de cycle. */
  private async assertValidParent(tx: TenantTx, siteId: string, parentId: string, selfId?: string): Promise<void> {
    if (parentId === selfId) throw DomainError.unprocessable('invalid_parent', 'Un service ne peut pas être son propre parent.');
    const parent = await tx.department.findFirst({ where: { id: parentId, deletedAt: null }, select: { siteId: true, parentId: true } });
    if (!parent || parent.siteId !== siteId) {
      throw DomainError.unprocessable('invalid_parent', 'Le service parent doit appartenir au même site.');
    }
    let cursor = parent.parentId;
    for (let depth = 0; selfId && cursor && depth < MAX_HIERARCHY_DEPTH; depth += 1) {
      if (cursor === selfId) throw DomainError.unprocessable('invalid_parent', 'Ce parent créerait une boucle dans la hiérarchie.');
      const ancestor = await tx.department.findFirst({ where: { id: cursor }, select: { parentId: true } });
      cursor = ancestor?.parentId ?? null;
    }
  }

  private async requireDepartment(tx: TenantTx, id: string) {
    const department = await tx.department.findFirst({ where: { id, deletedAt: null }, select: DEPARTMENT_SELECT });
    if (!department) throw DomainError.notFound('Service');
    return department;
  }
}
