import { describe, expect, it } from 'vitest';
import {
  buildManualPaymentInput,
  buildPlanVersionInput,
  moneyByCurrency,
  toManualPayment,
  toPlatformDashboard,
  toPlatformInvoice,
  toPlatformPlan,
  toPlatformSubscription,
  toTenantDetail,
  toTenantSummary,
} from './platform';

const NBSP = ' ';

const TENANT = {
  id: 't1', slug: 'clinique-a', name: 'Clinique A', establishmentType: 'clinic', countryCode: 'SN', status: 'active', createdAt: '2026-09-01T00:00:00.000Z',
  subscription: { status: 'trial', planCode: 'standard', currentPeriodEnd: '2026-10-20T00:00:00.000Z' },
};

describe('mappers de la console plateforme', () => {
  it('toPlatformDashboard et montants par devise', () => {
    const dashboard = toPlatformDashboard({
      tenants: { total: 10, active: 7, trial: 2, suspended: 1 }, users: 80, patients: 1200, appointmentsLast30Days: 640,
      mrr: { XOF: '1250000.00', EUR: '100.00' }, arr: { XOF: '15000000.00' }, overdueInvoices: 3,
    });
    expect(dashboard).toMatchObject({ users: 80, overdueInvoices: 3, tenants: { total: 10, suspended: 1 } });
    expect(moneyByCurrency(dashboard.mrr)).toBe(`1${NBSP}250${NBSP}000${NBSP}FCFA · 100,00${NBSP}EUR`);
    expect(moneyByCurrency({})).toBe('-');
    expect(toPlatformDashboard(null)).toMatchObject({ tenants: { total: 0 }, mrr: {}, overdueInvoices: 0 });
    expect(toPlatformDashboard({ mrr: { XOF: 12, EUR: '1.00' } }).mrr).toEqual({ EUR: '1.00' });
  });

  it('toTenantSummary / toTenantDetail', () => {
    expect(toTenantSummary(TENANT)).toMatchObject({ slug: 'clinique-a', subscription: { planCode: 'standard', status: 'trial' } });
    expect(toTenantSummary({ ...TENANT, subscription: null }).subscription).toBeNull();
    const detail = toTenantDetail({
      tenant: { ...TENANT, legalName: 'SARL Clinique A', baseCurrency: 'XOF', timezone: 'Africa/Dakar', suspensionReason: null },
      subscription: null, usage: { users: 4, sites: 1, patients: 300, appointmentsThisMonth: 50, appointmentsLast30Days: 70 },
      modules: ['billing', 'cashier'], invoices: { open: 1, overdue: 0 },
    });
    expect(detail.tenant).toMatchObject({ legalName: 'SARL Clinique A', baseCurrency: 'XOF', suspensionReason: null });
    expect(detail.usage).toEqual({ users: 4, sites: 1, patients: 300, appointmentsThisMonth: 50, appointmentsLast30Days: 70 });
    expect(detail.modules).toEqual(['billing', 'cashier']);
    expect(toTenantDetail(undefined)).toMatchObject({ subscription: null, invoices: { open: 0, overdue: 0 }, modules: [] });
  });

  it('toPlatformSubscription ajoute tenantId, essai prolongé et motif', () => {
    const sub = toPlatformSubscription({ id: 's1', status: 'trial', tenantId: 't1', trialExtended: true, suspensionReason: 'Impayé' });
    expect(sub).toMatchObject({ tenantId: 't1', trialExtended: true, suspensionReason: 'Impayé', status: 'trial' });
    expect(toPlatformSubscription({})).toBeNull();
  });

  it('toPlatformPlan, toPlatformInvoice, toManualPayment', () => {
    const plan = toPlatformPlan({ id: 'p', code: 'basic', version: 2, name: 'Basic', tier: 'basic', priceMonthly: '25000.00', priceYearly: '250000.00', currency: 'XOF', isPublic: true, archivedAt: null, createdAt: 'c', entitlements: { modules: ['billing'] } });
    expect(plan).toMatchObject({ version: 2, isPublic: true, archivedAt: null });
    expect(plan.entitlements.modules).toEqual(['billing']);
    const invoice = toPlatformInvoice({ id: 'i', number: 'GHMT-SN-2026-000001', status: 'open', total: '29500.00', tenantId: 't1', tenantSlug: 'clinique-a' });
    expect(invoice).toMatchObject({ tenantId: 't1', tenantSlug: 'clinique-a', total: '29500.00' });
    const payment = toManualPayment({ id: 'm', invoiceId: 'i', invoiceNumber: 'N', tenantId: 't1', amount: '29500.00', currency: 'XOF', method: 'bank_transfer', reference: 'VIR-1', receivedAt: 'r', status: 'pending', enteredBy: 'u1', decidedBy: null, decidedAt: null, rejectionReason: null, createdAt: 'c' });
    expect(payment).toMatchObject({ method: 'bank_transfer', status: 'pending', enteredBy: 'u1', decidedBy: null });
    expect(toManualPayment({ method: '?', status: '?' })).toMatchObject({ method: 'other', status: 'pending' });
  });
});

describe('buildPlanVersionInput', () => {
  const FLAT = {
    code: 'standard', name: 'Standard', tier: 'standard', priceMonthly: '80 000', priceYearly: '800000', currency: 'xof',
    modules: 'billing, cashier\nappointments', 'limits.users': '30', 'limits.sites': '', 'limits.appointmentsMonthly': '4000',
    'limits.activePatients': '', 'limits.smsMonthly': '1000', 'limits.storageGb': '60',
    'features.export': 'on', 'features.api': 'on', isPublic: 'on',
  };
  it('construit la nouvelle version : illimité si vide, modules dédoublonnés, cases à cocher', () => {
    const result = buildPlanVersionInput(FLAT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toMatchObject({
      code: 'standard', priceMonthly: '80000.00', priceYearly: '800000.00', currency: 'XOF', isPublic: true,
      entitlements: {
        modules: ['appointments', 'billing', 'cashier'],
        limits: { users: 30, sites: null, appointmentsMonthly: 4000, activePatients: null, smsMonthly: 1000, storageGb: 60 },
        features: { customRoles: false, export: true, api: true },
      },
    });
  });
  it('isPublic décoché', () => {
    const result = buildPlanVersionInput({ ...FLAT, isPublic: '' });
    expect(result.ok && result.body.isPublic).toBe(false);
  });
  it('signale les erreurs par champ (prix, limite non entière, modules requis, code)', () => {
    const result = buildPlanVersionInput({ ...FLAT, priceMonthly: 'x', 'limits.users': '-3', modules: 'billing', code: 'Bad Code' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fieldErrors.priceMonthly).toBeDefined();
    expect(result.fieldErrors['limits.users']).toBeDefined();
    expect(result.fieldErrors.code).toBeDefined();
  });
  it('exige les modules billing et cashier', () => {
    const result = buildPlanVersionInput({ ...FLAT, modules: 'appointments' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors.modules).toContain('billing');
  });
});

describe('buildManualPaymentInput', () => {
  it('construit le corps à partir d\'une date de réception', () => {
    expect(buildManualPaymentInput({ amount: '29 500', method: 'bank_transfer', reference: ' VIR-001 ', receivedAt: '2026-10-03' })).toEqual({
      ok: true,
      body: { amount: '29500.00', method: 'bank_transfer', reference: 'VIR-001', receivedAt: '2026-10-03T00:00:00.000Z' },
    });
  });
  it('refuse montant, mode, référence et date invalides', () => {
    const result = buildManualPaymentInput({ amount: 'x', method: 'crypto', reference: '', receivedAt: '03/10/2026' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.fieldErrors).sort()).toEqual(['amount', 'method', 'receivedAt', 'reference']);
  });
});
