import { describe, expect, it } from 'vitest';
import {
  PLATFORM_PERMISSIONS,
  createManualPaymentSchema,
  createPlanVersionSchema,
  platformLoginSchema,
  platformMfaVerifySchema,
  platformRoleHas,
  suspendTenantSchema,
} from './platform';
import { DEFAULT_PLAN_CATALOG } from './subscriptions';

describe('matrice des rôles plateforme (docs/09 §A1)', () => {
  it('super_admin détient toutes les permissions', () => {
    for (const permission of PLATFORM_PERMISSIONS) expect(platformRoleHas('super_admin', permission)).toBe(true);
  });

  it('support : lecture seule des tenants et abonnements, rien sur les factures ni la suspension', () => {
    expect(platformRoleHas('support', 'tenants:read')).toBe(true);
    expect(platformRoleHas('support', 'subscriptions:read')).toBe(true);
    for (const denied of ['tenants:suspend', 'plans:write', 'subscriptions:write', 'invoices:read', 'invoices:write', 'invoices:validate'] as const) {
      expect(platformRoleHas('support', denied), denied).toBe(false);
    }
  });

  it('billing : plans, abonnements, factures et paiements manuels, mais pas la suspension d’un tenant', () => {
    for (const allowed of ['plans:write', 'subscriptions:write', 'invoices:read', 'invoices:write', 'invoices:validate'] as const) {
      expect(platformRoleHas('billing', allowed), allowed).toBe(true);
    }
    expect(platformRoleHas('billing', 'tenants:suspend')).toBe(false);
  });
});

describe('schémas plateforme', () => {
  it('normalise l’e-mail de connexion en minuscules', () => {
    expect(platformLoginSchema.parse({ email: 'Admin@Ghmt.TEST', password: 'x' }).email).toBe('admin@ghmt.test');
  });

  it('accepte un code TOTP ou de secours', () => {
    const challengeId = 'a'.repeat(32);
    expect(platformMfaVerifySchema.safeParse({ challengeId, code: '123456' }).success).toBe(true);
    expect(platformMfaVerifySchema.safeParse({ challengeId, code: 'ABCDE23456' }).success).toBe(true);
    expect(platformMfaVerifySchema.safeParse({ challengeId, code: '12345' }).success).toBe(false);
  });

  it('exige un motif pour suspendre', () => {
    expect(suspendTenantSchema.safeParse({ reason: '' }).success).toBe(false);
    expect(suspendTenantSchema.safeParse({ reason: 'Impayé confirmé' }).success).toBe(true);
  });

  it('valide une nouvelle version de plan et refuse un montant flottant', () => {
    const basic = DEFAULT_PLAN_CATALOG[0]!;
    const valid = { ...basic, isPublic: true };
    expect(createPlanVersionSchema.safeParse(valid).success).toBe(true);
    expect(createPlanVersionSchema.safeParse({ ...valid, priceMonthly: '25000,5' }).success).toBe(false);
    expect(createPlanVersionSchema.safeParse({ ...valid, priceMonthly: '1.234' }).success).toBe(false);
  });

  it('valide la saisie d’un paiement manuel', () => {
    const payload = { amount: '88500.00', method: 'bank_transfer', reference: 'VIR-2026-001', receivedAt: '2026-10-04T10:00:00Z' };
    expect(createManualPaymentSchema.safeParse(payload).success).toBe(true);
    expect(createManualPaymentSchema.safeParse({ ...payload, method: 'crypto' }).success).toBe(false);
  });
});
