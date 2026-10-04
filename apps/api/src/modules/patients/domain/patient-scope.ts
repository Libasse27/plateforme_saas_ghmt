import type { Prisma } from '../../../generated/prisma/client';

export interface PatientPermissionScope {
  readonly allTenant: boolean;
  readonly siteIds: readonly string[];
  readonly departmentIds: readonly string[];
}

/**
 * Filtre de périmètre des patients (A6) sur `primarySiteId`.
 * - portée établissement : aucun filtre ;
 * - sinon : sites de la portée (et sites des services de la portée) + patients sans site principal
 *   (NULL = visible par tous les détenteurs de la permission).
 */
export function buildPatientScopeFilter(scope: PatientPermissionScope, departmentSiteIds: readonly string[]): Prisma.PatientWhereInput {
  if (scope.allTenant) return {};
  const siteIds = [...new Set([...scope.siteIds, ...departmentSiteIds])];
  return { OR: [{ primarySiteId: null }, { primarySiteId: { in: siteIds } }] };
}

/** Un site cible est-il couvert par la portée ? (création / déplacement d'un patient vers un site). */
export function isSiteWithinPatientScope(scope: PatientPermissionScope, siteId: string, departmentSiteIds: readonly string[]): boolean {
  return scope.allTenant || scope.siteIds.includes(siteId) || departmentSiteIds.includes(siteId);
}

/**
 * Un patient (par son site principal) est-il couvert par la portée ? Même règle que `buildPatientScopeFilter` :
 * NULL = visible par tous les détenteurs de la permission ; une portée vide (permission non détenue) ne couvre rien.
 */
export function isPatientWithinScope(scope: PatientPermissionScope, primarySiteId: string | null, departmentSiteIds: readonly string[]): boolean {
  if (scope.allTenant) return true;
  const holdsPermission = scope.siteIds.length > 0 || scope.departmentIds.length > 0;
  if (!holdsPermission) return false;
  return primarySiteId === null || scope.siteIds.includes(primarySiteId) || departmentSiteIds.includes(primarySiteId);
}
