import { Injectable } from '@nestjs/common';
import type { PermissionKey } from '@ghmt/shared';
import { scopesFor } from '../../../common/authz/authorization.service';
import { RequestContext } from '../../../common/context/request-context';
import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { buildSiteScopeFilter, isSiteInScope } from '../domain/billing-scope';
import { InvoicesRepository } from '../repositories/invoices.repository';

export interface ResolvedSiteScope {
  readonly filter: { siteId?: { in: string[] } };
  includes(siteId: string): boolean;
}

/** Résout la portée d'une permission (établissement, sites, services) en sites utilisables pour filtrer et contrôler. */
@Injectable()
export class SiteScopeService {
  constructor(
    private readonly context: RequestContext,
    private readonly invoices: InvoicesRepository,
  ) {}

  async resolve(tx: TenantTx, tenantId: string, permission: PermissionKey): Promise<ResolvedSiteScope> {
    const scope = scopesFor(permission, this.context.grants);
    const departmentSites = scope.allTenant ? [] : await this.invoices.siteIdsOfDepartments(tx, tenantId, scope.departmentIds);
    return {
      filter: buildSiteScopeFilter(scope, departmentSites),
      includes: (siteId) => isSiteInScope(scope, siteId, departmentSites),
    };
  }
}
