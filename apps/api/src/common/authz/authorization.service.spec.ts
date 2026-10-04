import { describe, expect, it } from 'vitest';
import { evaluateAuthorization, scopesFor } from './authorization.service';
import type { AuthorizationInput, EffectiveGrant } from './authorization.types';

const grant = (permission: EffectiveGrant['permission'], extra: Partial<EffectiveGrant> = {}): EffectiveGrant => ({
  permission,
  scopeType: 'tenant',
  scopeId: null,
  mfaRequired: false,
  ...extra,
});

const base: AuthorizationInput = {
  required: ['patients:patient:read'],
  grants: [grant('patients:patient:read')],
  enabledModules: new Set(['patients', 'appointments']),
  tenantStatus: 'active',
  mfaVerified: false,
};

describe('evaluateAuthorization', () => {
  it('autorise quand la permission est détenue et le module actif', () => {
    expect(evaluateAuthorization(base)).toEqual({ allowed: true });
  });

  it('refuse sans la permission', () => {
    expect(evaluateAuthorization({ ...base, grants: [] })).toMatchObject({ allowed: false, reason: 'permission_denied' });
  });

  it('exige toutes les permissions demandées', () => {
    const decision = evaluateAuthorization({ ...base, required: ['patients:patient:read', 'patients:patient:update'] });
    expect(decision).toMatchObject({ allowed: false, reason: 'permission_denied', permission: 'patients:patient:update' });
  });

  it('refuse un module non souscrit même si le rôle contient la permission', () => {
    const decision = evaluateAuthorization({
      ...base,
      required: ['pharmacy:drug:read'],
      grants: [grant('pharmacy:drug:read')],
    });
    expect(decision).toMatchObject({ allowed: false, reason: 'module_not_enabled' });
  });

  it('refuse tout accès à un tenant inactif ou inconnu', () => {
    expect(evaluateAuthorization({ ...base, tenantStatus: 'terminated' })).toMatchObject({ reason: 'tenant_inactive' });
    expect(evaluateAuthorization({ ...base, tenantStatus: undefined })).toMatchObject({ reason: 'tenant_inactive' });
  });

  it('limite un tenant suspendu à la lecture', () => {
    expect(evaluateAuthorization({ ...base, tenantStatus: 'suspended' })).toEqual({ allowed: true });
    const write = evaluateAuthorization({
      ...base,
      tenantStatus: 'suspended',
      required: ['patients:patient:create'],
      grants: [grant('patients:patient:create')],
    });
    expect(write).toMatchObject({ allowed: false, reason: 'subscription_suspended' });
  });

  it('exige la MFA si un rôle de l’utilisateur l’impose', () => {
    const grants = [grant('patients:patient:read', { mfaRequired: true })];
    expect(evaluateAuthorization({ ...base, grants })).toMatchObject({ reason: 'mfa_enrollment_required' });
    expect(evaluateAuthorization({ ...base, grants, mfaVerified: true })).toEqual({ allowed: true });
  });
});

describe('scopesFor', () => {
  it('agrège les portées tenant, site et service sans doublon', () => {
    const grants = [
      grant('patients:patient:read', { scopeType: 'site', scopeId: 's1' }),
      grant('patients:patient:read', { scopeType: 'site', scopeId: 's1' }),
      grant('patients:patient:read', { scopeType: 'department', scopeId: 'd1' }),
      grant('patients:patient:update', { scopeType: 'tenant' }),
    ];
    expect(scopesFor('patients:patient:read', grants)).toEqual({ allTenant: false, siteIds: ['s1'], departmentIds: ['d1'] });
    expect(scopesFor('patients:patient:update', grants).allTenant).toBe(true);
  });
});
