import type { PermissionKey } from '@ghmt/shared';
import { scopesFor } from '../../../common/authz/authorization.service';
import type { EffectiveGrant } from '../../../common/authz/authorization.types';

export interface DashboardSections {
  readonly patients: boolean;
  readonly appointments: boolean;
  readonly revenue: boolean;
  readonly cashSessions: boolean;
}

export interface MergedScope {
  readonly allTenant: boolean;
  readonly siteIds: readonly string[];
  readonly departmentIds: readonly string[];
}

export const REVENUE_PERMISSIONS: readonly PermissionKey[] = ['cashier:payment:read', 'billing:invoice:read'];
export const APPOINTMENT_PERMISSIONS: readonly PermissionKey[] = ['appointments:appointment:read', 'appointments:agenda:read'];
export const SECTION_PERMISSIONS = {
  patients: ['patients:patient:read'],
  appointments: APPOINTMENT_PERMISSIONS,
  revenue: REVENUE_PERMISSIONS,
  cashSessions: ['cashier:cash_session:read'],
} as const satisfies Record<keyof DashboardSections, readonly PermissionKey[]>;

function holdsAny(grants: readonly EffectiveGrant[], permissions: readonly PermissionKey[]): boolean {
  return grants.some((grant) => permissions.includes(grant.permission));
}

/** Sections ouvertes : permission requise ET module souscrit (docs/10 §6). Une section fermée vaut `null` dans la vue. */
export function resolveDashboardSections(grants: readonly EffectiveGrant[], modules: ReadonlySet<string>): DashboardSections {
  return {
    patients: holdsAny(grants, SECTION_PERMISSIONS.patients),
    appointments: modules.has('appointments') && holdsAny(grants, SECTION_PERMISSIONS.appointments),
    revenue: (modules.has('billing') || modules.has('cashier')) && holdsAny(grants, SECTION_PERMISSIONS.revenue),
    cashSessions: modules.has('cashier') && holdsAny(grants, SECTION_PERMISSIONS.cashSessions),
  };
}

/** Réunion des portées de toutes les permissions détenues parmi `permissions` (une section peut s'ouvrir par deux permissions). */
export function mergedScope(grants: readonly EffectiveGrant[], permissions: readonly PermissionKey[]): MergedScope {
  const scopes = permissions.map((permission) => scopesFor(permission, grants));
  return {
    allTenant: scopes.some((scope) => scope.allTenant),
    siteIds: [...new Set(scopes.flatMap((scope) => scope.siteIds))],
    departmentIds: [...new Set(scopes.flatMap((scope) => scope.departmentIds))],
  };
}
