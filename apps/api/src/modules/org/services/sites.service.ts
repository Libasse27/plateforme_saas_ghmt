import { Injectable } from '@nestjs/common';
import { AuditService } from '../../../common/audit/audit.service';
import { scopesFor } from '../../../common/authz/authorization.service';
import { RequestContext } from '../../../common/context/request-context';
import { DomainError } from '../../../common/errors/domain-error';
import { TenantDb, type TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { SITE_SELECT, toSiteDto } from '../mappers/org.mappers';
import { canAccessSite, diffChanges, siteScopeWhere } from './org-scope';
import type { CreateSiteInput, UpdateSiteInput } from './org.types';

const CODE_CONFLICT = 'Ce code de site est déjà utilisé.';

@Injectable()
export class SitesService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
    private readonly context: RequestContext,
  ) {}

  async list() {
    const scopes = scopesFor('org:site:read', this.context.grants);
    const rows = await this.tenantDb.run((tx) =>
      tx.site.findMany({ where: { deletedAt: null, ...siteScopeWhere(scopes) }, select: SITE_SELECT, orderBy: [{ isMain: 'desc' }, { code: 'asc' }] }),
    );
    return rows.map(toSiteDto);
  }

  async get(id: string) {
    const scopes = scopesFor('org:site:read', this.context.grants);
    return this.tenantDb.run(async (tx) => {
      // Hors portée : 404, comme une ressource inexistante.
      if (!canAccessSite(scopes, id)) throw DomainError.notFound('Site');
      return toSiteDto(await this.requireSite(tx, id));
    });
  }

  async create(input: CreateSiteInput) {
    const principal = this.context.requirePrincipal();
    // Un nouveau site n'appartient à aucune portée existante : réservé à la portée établissement.
    if (!scopesFor('org:site:create', this.context.grants).allTenant) {
      throw DomainError.forbidden('out_of_scope', 'La création d’un site exige un droit sur tout l’établissement.', 'org:site:create');
    }
    return this.tenantDb.run(async (tx) => {
      await this.assertCodeFree(tx, input.code);
      const site = await tx.site.create({
        data: { ...input, tenantId: principal.tenantId, createdBy: principal.userId },
        select: SITE_SELECT,
      });
      await this.audit.record(tx, principal.tenantId, {
        action: 'org.site.created',
        resourceType: 'site',
        resourceId: site.id,
        changes: { after: { code: site.code, name: site.name, city: site.city } },
      });
      return toSiteDto(site);
    });
  }

  async update(id: string, input: UpdateSiteInput) {
    const principal = this.context.requirePrincipal();
    return this.tenantDb.run(async (tx) => {
      const current = await this.requireSite(tx, id);
      this.assertWritable('org:site:update', id);
      if (input.code !== undefined && input.code !== current.code) await this.assertCodeFree(tx, input.code, id);

      const updated = await tx.site.update({
        where: { tenantId_id: { tenantId: principal.tenantId, id } },
        data: { ...input, updatedBy: principal.userId, rowVersion: { increment: 1 } },
        select: SITE_SELECT,
      });
      await this.audit.record(tx, principal.tenantId, {
        action: 'org.site.updated',
        resourceType: 'site',
        resourceId: id,
        changes: diffChanges(current, input),
      });
      return toSiteDto(updated);
    });
  }

  async remove(id: string): Promise<void> {
    const principal = this.context.requirePrincipal();
    await this.tenantDb.run(async (tx) => {
      const site = await this.requireSite(tx, id);
      this.assertWritable('org:site:delete', id);
      if (site.isMain) throw DomainError.conflict('main_site', 'Le site principal ne peut pas être supprimé.');
      const activeDepartments = await tx.department.count({ where: { siteId: id, deletedAt: null } });
      if (activeDepartments > 0) {
        throw DomainError.conflict('site_has_departments', 'Ce site a encore des services actifs : supprimez-les d’abord.');
      }
      await tx.site.update({
        where: { tenantId_id: { tenantId: principal.tenantId, id } },
        data: { deletedAt: new Date(), updatedBy: principal.userId, rowVersion: { increment: 1 } },
      });
      await this.audit.record(tx, principal.tenantId, {
        action: 'org.site.deleted',
        resourceType: 'site',
        resourceId: id,
        changes: { before: { code: site.code, name: site.name } },
      });
    });
  }

  private assertWritable(permission: 'org:site:update' | 'org:site:delete', siteId: string): void {
    if (!canAccessSite(scopesFor(permission, this.context.grants), siteId)) {
      throw DomainError.forbidden('out_of_scope', 'Ce site est hors de votre portée.', permission);
    }
  }

  private async assertCodeFree(tx: TenantTx, code: string, excludeId?: string): Promise<void> {
    const existing = await tx.site.findFirst({
      where: { code, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { id: true },
    });
    if (existing) throw DomainError.conflict('site_code_conflict', CODE_CONFLICT);
  }

  private async requireSite(tx: TenantTx, id: string) {
    const site = await tx.site.findFirst({ where: { id, deletedAt: null }, select: SITE_SELECT });
    if (!site) throw DomainError.notFound('Site');
    return site;
  }
}
