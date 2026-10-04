/** Filtrage des ressources d'organisation par portée de l'acteur (résultat de `scopesFor`). */

export interface Scopes {
  readonly allTenant: boolean;
  readonly siteIds: readonly string[];
  readonly departmentIds: readonly string[];
}

export function canAccessSite(scopes: Scopes, siteId: string): boolean {
  return scopes.allTenant || scopes.siteIds.includes(siteId);
}

export function canAccessDepartment(scopes: Scopes, department: { readonly id: string; readonly siteId: string }): boolean {
  return scopes.allTenant || scopes.siteIds.includes(department.siteId) || scopes.departmentIds.includes(department.id);
}

/** Clause Prisma restreignant les sites visibles. */
export function siteScopeWhere(scopes: Scopes): { id?: { in: string[] } } {
  return scopes.allTenant ? {} : { id: { in: [...scopes.siteIds] } };
}

/** Clause Prisma restreignant les services visibles (sites de la portée + services explicitement affectés). */
export function departmentScopeWhere(scopes: Scopes): { OR?: ({ siteId: { in: string[] } } | { id: { in: string[] } })[] } {
  if (scopes.allTenant) return {};
  return { OR: [{ siteId: { in: [...scopes.siteIds] } }, { id: { in: [...scopes.departmentIds] } }] };
}

/** Avant/après limités aux champs modifiés (audit), sans muter les entrées. */
export function diffChanges(
  current: Readonly<Record<string, unknown>>,
  patch: Readonly<Record<string, unknown>>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const changedKeys = Object.keys(patch).filter((key) => patch[key] !== undefined && patch[key] !== current[key]);
  return {
    before: Object.fromEntries(changedKeys.map((key) => [key, current[key]])),
    after: Object.fromEntries(changedKeys.map((key) => [key, patch[key]])),
  };
}
