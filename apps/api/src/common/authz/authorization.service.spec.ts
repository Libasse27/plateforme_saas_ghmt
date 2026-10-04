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
      required: ['patients:patient:update'],
      grants: [grant('patients:patient:update')],
    });
    expect(write).toMatchObject({ allowed: false, reason: 'subscription_suspended' });
  });

  describe('tenant suspendu : continuité des soins (docs/09 §A3)', () => {
    const suspended = { ...base, tenantStatus: 'suspended' } as const;
    const allowedWith = (permission: EffectiveGrant['permission']) =>
      evaluateAuthorization({ ...suspended, required: [permission], grants: [grant(permission)], enabledModules: new Set(['patients', 'cashier', 'billing', 'iam', 'org']) });

    it.each(['patients:patient:create', 'cashier:payment:create', 'cashier:cash_session:create'] as const)('autorise %s', (permission) => {
      expect(allowedWith(permission)).toEqual({ allowed: true });
    });

    it('autorise l’export et l’impression (l’administrateur peut exporter ses données)', () => {
      expect(allowedWith('patients:patient:export')).toEqual({ allowed: true });
      expect(allowedWith('billing:invoice:print')).toEqual({ allowed: true });
    });

    it.each(['patients:patient:update', 'patients:patient:delete', 'billing:invoice:create', 'iam:user:create', 'org:site:create'] as const)(
      'refuse %s',
      (permission) => {
        expect(allowedWith(permission)).toMatchObject({ allowed: false, reason: 'subscription_suspended' });
      },
    );

    it('autorise une route explicitement marquée « autorisée en suspension » (paiement de l’abonnement)', () => {
      const decision = evaluateAuthorization({
        ...suspended,
        required: ['settings:establishment:update'],
        grants: [grant('settings:establishment:update')],
        enabledModules: new Set(['settings']),
        allowWhenSuspended: true,
      });
      expect(decision).toEqual({ allowed: true });
    });

    it('n’exempte pas une route marquée si la permission manque', () => {
      const decision = evaluateAuthorization({ ...suspended, required: ['settings:establishment:update'], grants: [], enabledModules: new Set(['settings']), allowWhenSuspended: true });
      expect(decision).toMatchObject({ allowed: false, reason: 'permission_denied' });
    });
  });

  describe('abonnement en grace : actions administratives non essentielles bloquées (docs/05 A6)', () => {
    const grace = { ...base, subscriptionStatus: 'grace' } as const;
    const decide = (permission: EffectiveGrant['permission']) =>
      evaluateAuthorization({ ...grace, required: [permission], grants: [grant(permission)], enabledModules: new Set(['patients', 'iam', 'billing', 'org']) });

    it.each(['iam:user:create', 'iam:invitation:create', 'patients:patient:export', 'billing:invoice:export', 'iam:user:export'] as const)(
      'refuse %s',
      (permission) => {
        expect(decide(permission)).toMatchObject({ allowed: false, reason: 'subscription_grace', permission });
      },
    );

    it.each(['patients:patient:create', 'patients:patient:update', 'patients:patient:read', 'org:site:create'] as const)('autorise %s (les soins restent complets)', (permission) => {
      expect(decide(permission)).toEqual({ allowed: true });
    });

    it('ne bloque rien pour les autres statuts d’abonnement', () => {
      for (const subscriptionStatus of ['trial', 'active', 'past_due', undefined] as const) {
        const decision = evaluateAuthorization({ ...base, subscriptionStatus, required: ['iam:user:create'], grants: [grant('iam:user:create')], enabledModules: new Set(['iam']) });
        expect(decision).toEqual({ allowed: true });
      }
    });
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
