import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { okEnvelope, problem } from '@/lib/api/test-helpers';

vi.mock('next/navigation', async () => (await import('./test-kit')).navigationMock());
vi.mock('next/cache', async () => (await import('./test-kit')).cacheMock());
vi.mock('next/headers', async () => (await import('./test-kit')).headersMock());

import {
  changeTenantPlanAction,
  createPlanVersionAction,
  extendTrialAction,
  reactivateTenantAction,
  recordManualPaymentAction,
  rejectManualPaymentAction,
  suspendTenantAction,
  validateManualPaymentAction,
} from './platform-console';
import { form, redirectOf, stubApi } from './test-kit';

const TENANT = 'dd2b8c1e-1a2b-4c3d-8e9f-0123456789ab';
const INVOICE = '6c2b8c1e-1a2b-4c3d-8e9f-0123456789ab';
const PAYMENT = '9f2b8c1e-1a2b-4c3d-8e9f-0123456789ab';

beforeEach(() => {
  vi.stubEnv('API_URL', 'http://api.test/api/v1');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('établissements', () => {
  it('suspend avec un motif et utilise le jeton plateforme (jamais celui de l\'établissement)', async () => {
    const { calls } = stubApi(() => okEnvelope({ id: TENANT }));
    const state = await suspendTenantAction({}, form({ tenantId: TENANT, reason: 'Impayés répétés' }));
    expect(state.message).toContain('suspendu');
    expect(calls.at(-1)).toMatchObject({ path: `/platform/tenants/${TENANT}/suspend`, body: { reason: 'Impayés répétés' }, authorization: 'Bearer platform-access' });
  });
  it('motif trop court, identifiant invalide, déjà suspendu', async () => {
    stubApi(() => problem(409, 'already_suspended'));
    expect((await suspendTenantAction({}, form({ tenantId: TENANT, reason: 'abc' }))).fieldErrors?.reason).toBeDefined();
    expect((await suspendTenantAction({}, form({ tenantId: 'x', reason: 'Impayés répétés' }))).ok).toBe(false);
    expect((await suspendTenantAction({}, form({ tenantId: TENANT, reason: 'Impayés répétés' }))).message).toContain('déjà suspendu');
  });
  it('réactive ; not_manually_suspended expliqué', async () => {
    const { calls } = stubApi(() => okEnvelope({ id: TENANT }));
    expect((await reactivateTenantAction({}, form({ tenantId: TENANT }))).ok).toBe(true);
    expect(calls.at(-1)?.path).toBe(`/platform/tenants/${TENANT}/reactivate`);
    stubApi(() => problem(409, 'not_manually_suspended'));
    expect((await reactivateTenantAction({}, form({ tenantId: TENANT }))).message).toContain('abonnement');
    expect((await reactivateTenantAction({}, form({ tenantId: 'x' }))).ok).toBe(false);
  });
});

describe('plans et abonnements', () => {
  const PLAN = {
    code: 'standard', name: 'Standard', tier: 'standard', priceMonthly: '80000', priceYearly: '800000', currency: 'XOF',
    modules: 'billing cashier appointments', 'limits.users': '30', isPublic: 'on',
  };
  it('publie une nouvelle version de plan', async () => {
    const { calls } = stubApi(() => okEnvelope({ id: 'p2' }, {}, 201));
    const state = await createPlanVersionAction({}, form(PLAN));
    expect(state.message).toContain('Nouvelle version');
    expect(calls.at(-1)?.body).toMatchObject({ code: 'standard', priceMonthly: '80000.00', entitlements: { limits: { users: 30, sites: null } } });
  });
  it('erreurs de formulaire et de version', async () => {
    stubApi(() => problem(409, 'plan_version_conflict'));
    expect((await createPlanVersionAction({}, form({ ...PLAN, modules: 'appointments' }))).fieldErrors?.modules).toBeDefined();
    expect((await createPlanVersionAction({}, form(PLAN))).message).toContain('autre version');
  });
  it('change le plan d\'un établissement', async () => {
    const { calls } = stubApi(() => okEnvelope({ effect: 'immediate' }));
    expect((await changeTenantPlanAction({}, form({ tenantId: TENANT, planCode: 'professional', billingPeriod: 'yearly' }))).ok).toBe(true);
    expect(calls.at(-1)?.body).toEqual({ planCode: 'professional', billingPeriod: 'yearly' });
    expect((await changeTenantPlanAction({}, form({ tenantId: TENANT, planCode: 'Bad Code', billingPeriod: 'yearly' }))).fieldErrors?.planCode).toBeDefined();
    expect((await changeTenantPlanAction({}, form({ tenantId: 'x', planCode: 'basic', billingPeriod: 'monthly' }))).ok).toBe(false);
    stubApi(() => problem(409, 'no_change'));
    expect((await changeTenantPlanAction({}, form({ tenantId: TENANT, planCode: 'basic', billingPeriod: 'monthly' }))).message).toContain('déjà');
  });
  it('prolonge l\'essai une seule fois', async () => {
    stubApi(() => okEnvelope({ id: 's' }));
    expect((await extendTrialAction({}, form({ tenantId: TENANT }))).message).toContain('15 jours');
    stubApi(() => problem(409, 'trial_already_extended'));
    expect((await extendTrialAction({}, form({ tenantId: TENANT }))).message).toContain('déjà été prolongé');
    expect((await extendTrialAction({}, form({ tenantId: 'x' }))).ok).toBe(false);
  });
});

describe('paiements manuels', () => {
  it('saisit un paiement manuel', async () => {
    const { calls } = stubApi(() => okEnvelope({ id: PAYMENT }, {}, 201));
    const state = await recordManualPaymentAction({}, form({ invoiceId: INVOICE, amount: '29 500', method: 'bank_transfer', reference: 'VIR-001', receivedAt: '2026-10-03' }));
    expect(state.message).toContain('autre administrateur');
    expect(calls.at(-1)).toMatchObject({ path: `/platform/invoices/${INVOICE}/manual-payments`, body: { amount: '29500.00', receivedAt: '2026-10-03T00:00:00.000Z' } });
  });
  it('erreurs de saisie, amount_mismatch', async () => {
    stubApi(() => problem(422, 'amount_mismatch'));
    expect((await recordManualPaymentAction({}, form({ invoiceId: INVOICE, amount: 'x', method: 'cheque', reference: '', receivedAt: 'hier' }))).fieldErrors?.amount).toBeDefined();
    expect((await recordManualPaymentAction({}, form({ invoiceId: 'x' }))).ok).toBe(false);
    expect((await recordManualPaymentAction({}, form({ invoiceId: INVOICE, amount: '1', method: 'cheque', reference: 'CHQ1', receivedAt: '2026-10-03' }))).message).toContain('exactement');
  });
  it('valide ; four_eyes_required expliqué', async () => {
    const { calls } = stubApi(() => okEnvelope({ id: PAYMENT }));
    expect((await validateManualPaymentAction({}, form({ paymentId: PAYMENT }))).ok).toBe(true);
    expect(calls.at(-1)?.path).toBe(`/platform/invoices/manual-payments/${PAYMENT}/validate`);
    stubApi(() => problem(403, 'four_eyes_required'));
    const denied = await validateManualPaymentAction({}, form({ paymentId: PAYMENT }));
    expect(denied.ok).toBe(false);
    expect(denied.message).toContain('quatre yeux');
    expect((await validateManualPaymentAction({}, form({ paymentId: 'x' }))).ok).toBe(false);
  });
  it('rejette avec motif', async () => {
    const { calls } = stubApi(() => okEnvelope({ id: PAYMENT }));
    expect((await rejectManualPaymentAction({}, form({ paymentId: PAYMENT, reason: 'Montant non reçu' }))).message).toBe('Paiement rejeté.');
    expect(calls.at(-1)?.body).toEqual({ reason: 'Montant non reçu' });
    expect((await rejectManualPaymentAction({}, form({ paymentId: PAYMENT, reason: 'no' }))).fieldErrors?.reason).toBeDefined();
    expect((await rejectManualPaymentAction({}, form({ paymentId: 'x', reason: 'Montant non reçu' }))).ok).toBe(false);
    stubApi(() => problem(409, 'manual_payment_decided'));
    expect((await rejectManualPaymentAction({}, form({ paymentId: PAYMENT, reason: 'Montant non reçu' }))).message).toContain('déjà');
  });
});

describe('session plateforme perdue', () => {
  it('redirige vers la connexion plateforme sur 401 persistant', async () => {
    stubApi(() => problem(401, 'unauthenticated'));
    const url = await redirectOf(suspendTenantAction({}, form({ tenantId: TENANT, reason: 'Impayés répétés' })));
    expect(url).toBe('/plateforme/connexion?session=expiree');
  });
});
