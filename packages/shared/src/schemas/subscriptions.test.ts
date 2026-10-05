import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLAN_CATALOG,
  changePlanSchema,
  entitlementOverridesSchema,
  entitlementsSchema,
  mergeEntitlements,
  payInvoiceSchema,
  type Entitlements,
} from './subscriptions';

const base: Entitlements = {
  modules: ['appointments', 'billing', 'cashier'],
  limits: { users: 5, sites: 1, appointmentsMonthly: 500, activePatients: 2000, smsMonthly: 200, storageGb: 5 },
  features: { customRoles: false, export: false, api: false },
};

describe('mergeEntitlements', () => {
  it('renvoie le plan tel quel sans dérogation', () => {
    expect(mergeEntitlements(base, null)).toBe(base);
    expect(mergeEntitlements(base, undefined)).toBe(base);
  });

  it('remplace les limites clé par clé, y compris par null (illimité)', () => {
    const merged = mergeEntitlements(base, { limits: { users: 50, sites: null } });
    expect(merged.limits).toEqual({ ...base.limits, users: 50, sites: null });
  });

  it('remplace les fonctionnalités et ajoute des modules sans doublon (triés)', () => {
    const merged = mergeEntitlements(base, { features: { export: true }, modules: ['laboratory', 'billing'] });
    expect(merged.features).toEqual({ customRoles: false, export: true, api: false });
    expect(merged.modules).toEqual(['appointments', 'billing', 'cashier', 'laboratory']);
  });

  it('ne mute pas le plan d’origine', () => {
    const copy = structuredClone(base);
    mergeEntitlements(base, { limits: { users: 1 }, modules: ['hr'] });
    expect(base).toEqual(copy);
  });
});

describe('schémas', () => {
  it('valide le catalogue initial : tous les plans incluent billing et cashier', () => {
    expect(DEFAULT_PLAN_CATALOG.map((p) => p.code)).toEqual(['basic', 'standard', 'professional', 'enterprise']);
    for (const plan of DEFAULT_PLAN_CATALOG) {
      expect(entitlementsSchema.safeParse(plan.entitlements).success).toBe(true);
      expect(plan.entitlements.modules).toEqual(expect.arrayContaining(['billing', 'cashier']));
    }
  });

  it('refuse une dérogation inconnue ou une limite négative', () => {
    expect(entitlementOverridesSchema.safeParse({ unknown: 1 }).success).toBe(false);
    expect(entitlementOverridesSchema.safeParse({ limits: { users: -1 } }).success).toBe(false);
  });

  it('valide le changement de plan et le téléphone E.164', () => {
    expect(changePlanSchema.safeParse({ planCode: 'standard', billingPeriod: 'monthly' }).success).toBe(true);
    expect(changePlanSchema.safeParse({ planCode: 'Standard!', billingPeriod: 'monthly' }).success).toBe(false);
    expect(changePlanSchema.safeParse({ planCode: 'standard', billingPeriod: 'weekly' }).success).toBe(false);
    expect(payInvoiceSchema.safeParse({ payerPhone: '+221771234567' }).success).toBe(true);
    expect(payInvoiceSchema.safeParse({ payerPhone: '0771234567' }).success).toBe(false);
  });
});
