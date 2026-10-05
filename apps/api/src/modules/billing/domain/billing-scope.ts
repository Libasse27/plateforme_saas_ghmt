import type { PermissionKey } from '@ghmt/shared';
import type { EffectiveGrant } from '../../../common/authz/authorization.types';

export interface SitePermissionScope {
  readonly allTenant: boolean;
  readonly siteIds: readonly string[];
  readonly departmentIds: readonly string[];
}

/** Filtre Prisma `siteId` d'une portée (factures, caisses) ; une portée vide ne couvre rien. */
export function buildSiteScopeFilter(scope: SitePermissionScope, departmentSiteIds: readonly string[]): { siteId?: { in: string[] } } {
  if (scope.allTenant) return {};
  return { siteId: { in: [...new Set([...scope.siteIds, ...departmentSiteIds])] } };
}

export function isSiteInScope(scope: SitePermissionScope, siteId: string, departmentSiteIds: readonly string[]): boolean {
  return scope.allTenant || scope.siteIds.includes(siteId) || departmentSiteIds.includes(siteId);
}

/** La permission est-elle détenue, quelle que soit sa portée ? (ex. ligne libre ⇒ `billing:invoice:update`). */
export function holdsPermission(permission: PermissionKey, grants: readonly EffectiveGrant[]): boolean {
  return grants.some((grant) => grant.permission === permission);
}
