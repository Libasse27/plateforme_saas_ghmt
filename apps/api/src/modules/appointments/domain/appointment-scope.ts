export interface PermissionScope {
  readonly allTenant: boolean;
  readonly siteIds: readonly string[];
  readonly departmentIds: readonly string[];
}

export interface AppointmentTarget {
  readonly siteId: string;
  readonly departmentId?: string | null;
}

/** Une portée couvre un rendez-vous si elle vise tout le tenant, son site ou le service du praticien. */
export function isWithinScope(scope: PermissionScope, target: AppointmentTarget): boolean {
  if (scope.allTenant) return true;
  if (scope.siteIds.includes(target.siteId)) return true;
  return target.departmentId != null && scope.departmentIds.includes(target.departmentId);
}
