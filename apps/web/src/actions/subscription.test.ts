import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { okEnvelope, problem } from '@/lib/api/test-helpers';

vi.mock('next/navigation', async () => (await import('./test-kit')).navigationMock());
vi.mock('next/cache', async () => (await import('./test-kit')).cacheMock());
vi.mock('next/headers', async () => (await import('./test-kit')).headersMock());

import { revalidatePath } from 'next/cache';
import { cancelSubscriptionAction, changePlanAction, paySaasInvoiceAction, resumeSubscriptionAction } from './subscription';
import { form, redirectOf, stubApi } from './test-kit';

const INVOICE_ID = '3f2b8c1e-1a2b-4c3d-8e9f-0123456789ab';
const SUB = { id: 's1', status: 'active', billingPeriod: 'monthly', currentPeriodEnd: '2026-10-20T00:00:00.000Z', plan: { code: 'standard', name: 'Standard' } };

beforeEach(() => {
  vi.stubEnv('API_URL', 'http://api.test/api/v1');
  vi.stubEnv('SESSION_COOKIE_SECURE', 'false');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.mocked(revalidatePath).mockClear();
});

describe('changePlanAction', () => {
  it('envoie planCode et billingPeriod puis affiche l\'effet immédiat', async () => {
    const { calls } = stubApi((c) => (c.path === '/subscription/change' ? okEnvelope({ effect: 'immediate', subscription: SUB, invoice: null }) : undefined));
    const state = await changePlanAction({}, form({ planCode: 'standard', billingPeriod: 'yearly' }));
    expect(state).toMatchObject({ ok: true });
    expect(state.message).toContain('immédiatement');
    const call = calls.find((c) => c.path === '/subscription/change');
    expect(call?.body).toEqual({ planCode: 'standard', billingPeriod: 'yearly' });
    expect(call?.authorization).toBe('Bearer tenant-access');
    expect(revalidatePath).toHaveBeenCalledWith('/abonnement');
  });

  it('affiche l\'effet programmé avec la date', async () => {
    stubApi(() => okEnvelope({ effect: 'scheduled', subscription: { ...SUB, pendingChange: { planCode: 'basic', billingPeriod: 'monthly', effectiveAt: '2026-10-20T00:00:00.000Z' } }, invoice: null }));
    expect((await changePlanAction({}, form({ planCode: 'basic', billingPeriod: 'monthly' }))).message).toContain('20/10/2026');
  });

  it('affiche pending_payment avec la facture à régler', async () => {
    stubApi(() => okEnvelope({ effect: 'pending_payment', subscription: SUB, invoice: { number: 'GHMT-SN-2026-000007', total: '29500.00', currency: 'XOF' } }));
    expect((await changePlanAction({}, form({ planCode: 'standard', billingPeriod: 'monthly' }))).message).toContain('GHMT-SN-2026-000007');
  });

  it('409 downgrade_incompatible : liste les dépassements', async () => {
    stubApi(() => problem(409, 'downgrade_incompatible', { details: { violations: [{ metric: 'users', limit: 5, current: 9 }] } }));
    const state = await changePlanAction({}, form({ planCode: 'basic', billingPeriod: 'monthly' }));
    expect(state.ok).toBe(false);
    expect(state.message).toContain('utilisateurs : 9 en cours pour 5 autorisés');
  });

  it('refuse un code de plan invalide sans appeler l\'API', async () => {
    const { calls } = stubApi(() => undefined);
    const state = await changePlanAction({}, form({ planCode: '../etc', billingPeriod: 'weekly' }));
    expect(state.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('résiliation et reprise', () => {
  it('cancel puis resume', async () => {
    const { calls } = stubApi(() => okEnvelope(SUB));
    expect((await cancelSubscriptionAction()).message).toContain('Résiliation programmée');
    expect((await resumeSubscriptionAction()).message).toContain('repris');
    expect(calls.map((c) => c.path)).toEqual(['/subscription/cancel', '/subscription/resume']);
  });
  it('409 invalid_state', async () => {
    stubApi(() => problem(409, 'invalid_state'));
    expect((await cancelSubscriptionAction()).message).toContain('état actuel');
  });
});

describe('paySaasInvoiceAction', () => {
  it('normalise le téléphone (E.164) dans le corps, jamais dans l\'URL, et redirige vers checkoutUrl', async () => {
    const { calls } = stubApi((c) =>
      c.path.endsWith('/pay') ? okEnvelope({ attemptId: 'a', status: 'pending', provider: 'cinetpay', checkoutUrl: 'https://pay.test/c/1', instructions: null }) : undefined,
    );
    const url = await redirectOf(paySaasInvoiceAction({}, form({ invoiceId: INVOICE_ID, payerPhone: '77 123 45 67' })));
    expect(url).toBe('https://pay.test/c/1');
    const call = calls.find((c) => c.path.endsWith('/pay'));
    expect(call?.path).toBe(`/subscription/invoices/${INVOICE_ID}/pay`);
    expect(call?.body).toEqual({ payerPhone: '+221771234567' });
    expect(call?.url).not.toContain('771234567');
  });

  it('sandbox : ajoute la page de retour /abonnement', async () => {
    stubApi(() => okEnvelope({ attemptId: 'a', status: 'pending', provider: 'sandbox', checkoutUrl: 'http://localhost:3001/sandbox/paiement/sbx-12345678', instructions: null }));
    const url = await redirectOf(paySaasInvoiceAction({}, form({ invoiceId: INVOICE_ID, payerPhone: '771234567' })));
    expect(url).toBe('http://localhost:3001/sandbox/paiement/sbx-12345678?retour=%2Fabonnement');
  });

  it('sans URL de paiement, affiche les instructions', async () => {
    stubApi(() => okEnvelope({ attemptId: 'a', status: 'pending', provider: 'x', checkoutUrl: null, instructions: 'Composez #144# pour valider.' }));
    const state = await paySaasInvoiceAction({}, form({ invoiceId: INVOICE_ID, payerPhone: '771234567' }));
    expect(state).toMatchObject({ ok: true, extra: { instructions: 'Composez #144# pour valider.' } });
  });

  it('téléphone invalide : erreur de champ sans appel de paiement', async () => {
    const { calls } = stubApi(() => undefined);
    const state = await paySaasInvoiceAction({}, form({ invoiceId: INVOICE_ID, payerPhone: '12' }));
    expect(state.fieldErrors?.payerPhone).toBeDefined();
    expect(calls.some((c) => c.path.endsWith('/pay'))).toBe(false);
  });

  it('identifiant de facture non UUID : demande invalide', async () => {
    const { calls } = stubApi(() => undefined);
    expect((await paySaasInvoiceAction({}, form({ invoiceId: '../../admin', payerPhone: '771234567' }))).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('503 payments_unavailable et 409 invoice_not_payable', async () => {
    stubApi(() => problem(503, 'payments_unavailable'));
    expect((await paySaasInvoiceAction({}, form({ invoiceId: INVOICE_ID, payerPhone: '771234567' }))).message).toContain('paiement');
    stubApi(() => problem(409, 'invoice_not_payable'));
    expect((await paySaasInvoiceAction({}, form({ invoiceId: INVOICE_ID, payerPhone: '771234567' }))).message).toContain('encaissée');
  });
});
