import type { PermissionKey } from '@ghmt/shared';
import { describe, expect, it } from 'vitest';
import type { EffectiveGrant } from '../../../common/authz/authorization.types';
import { REVENUE_PERMISSIONS, mergedScope, resolveDashboardSections, SECTION_PERMISSIONS } from './dashboard-sections';

const grant = (permission: PermissionKey, scopeType: EffectiveGrant['scopeType'] = 'tenant', scopeId: string | null = null): EffectiveGrant => ({
  permission,
  scopeType,
  scopeId,
  mfaRequired: false,
});
const ALL_MODULES = new Set(['appointments', 'billing', 'cashier']);

describe('resolveDashboardSections', () => {
  it('n’ouvre aucune section sans permission', () => {
    expect(resolveDashboardSections([], ALL_MODULES)).toEqual({ patients: false, appointments: false, revenue: false, cashSessions: false });
  });

  it('ouvre patients sans condition de module', () => {
    expect(resolveDashboardSections([grant('patients:patient:read')], new Set()).patients).toBe(true);
  });

  it.each<PermissionKey>(['appointments:appointment:read', 'appointments:agenda:read'])('ouvre rendez-vous avec %s et le module appointments', (permission) => {
    expect(resolveDashboardSections([grant(permission)], ALL_MODULES).appointments).toBe(true);
    expect(resolveDashboardSections([grant(permission)], new Set(['billing'])).appointments).toBe(false);
  });

  it.each<PermissionKey>(['cashier:payment:read', 'billing:invoice:read'])('ouvre recettes avec %s si billing ou cashier est actif', (permission) => {
    expect(resolveDashboardSections([grant(permission)], new Set(['billing'])).revenue).toBe(true);
    expect(resolveDashboardSections([grant(permission)], new Set(['cashier'])).revenue).toBe(true);
    expect(resolveDashboardSections([grant(permission)], new Set(['appointments'])).revenue).toBe(false);
  });

  it('ouvre les sessions de caisse avec cashier:cash_session:read et le module cashier', () => {
    const grants = [grant('cashier:cash_session:read')];

    expect(resolveDashboardSections(grants, new Set(['cashier'])).cashSessions).toBe(true);
    expect(resolveDashboardSections(grants, new Set(['billing'])).cashSessions).toBe(false);
  });

  it('expose les permissions de chaque section', () => {
    expect(SECTION_PERMISSIONS.patients).toEqual(['patients:patient:read']);
    expect(REVENUE_PERMISSIONS).toEqual(['cashier:payment:read', 'billing:invoice:read']);
  });
});

describe('mergedScope', () => {
  it('réunit les portées des permissions détenues et ignore les autres', () => {
    const grants = [
      grant('cashier:payment:read', 'site', 'site-1'),
      grant('billing:invoice:read', 'site', 'site-2'),
      grant('billing:invoice:read', 'department', 'dep-1'),
      grant('patients:patient:read', 'tenant'),
    ];

    expect(mergedScope(grants, REVENUE_PERMISSIONS)).toEqual({ allTenant: false, siteIds: ['site-1', 'site-2'], departmentIds: ['dep-1'] });
  });

  it('est établissement entier dès qu’une permission l’est', () => {
    const grants = [grant('cashier:payment:read', 'site', 'site-1'), grant('billing:invoice:read', 'tenant')];

    expect(mergedScope(grants, REVENUE_PERMISSIONS).allTenant).toBe(true);
  });

  it('ne couvre rien sans permission', () => {
    expect(mergedScope([], REVENUE_PERMISSIONS)).toEqual({ allTenant: false, siteIds: [], departmentIds: [] });
  });
});
