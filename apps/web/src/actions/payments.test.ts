import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { okEnvelope, problem } from '@/lib/api/test-helpers';

vi.mock('next/navigation', async () => (await import('./test-kit')).navigationMock());
vi.mock('next/cache', async () => (await import('./test-kit')).cacheMock());
vi.mock('next/headers', async () => (await import('./test-kit')).headersMock());

import { abandonPaymentAction, recordPaymentAction, refreshPaymentAction, simulateSandboxPaymentAction } from './payments';
import { form, redirectOf, stubApi } from './test-kit';

const INVOICE = '6c2b8c1e-1a2b-4c3d-8e9f-0123456789ab';
const SESSION = '8e2b8c1e-1a2b-4c3d-8e9f-0123456789ab';
const PAYMENT = '9f2b8c1e-1a2b-4c3d-8e9f-0123456789ab';
const NBSP = ' ';

const CASH_PAYMENT = { id: PAYMENT, method: 'cash', amount: '10000.00', currency: 'XOF', status: 'succeeded' };

beforeEach(() => {
  vi.stubEnv('API_URL', 'http://api.test/api/v1');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('recordPaymentAction : espèces et autre mode', () => {
  it('encaisse en espèces avec la session de caisse', async () => {
    const { calls } = stubApi(() => okEnvelope(CASH_PAYMENT, {}, 201));
    const state = await recordPaymentAction({}, form({ invoiceId: INVOICE, method: 'cash', amount: '10 000', cashSessionId: SESSION, currency: 'XOF' }));
    expect(state).toMatchObject({ ok: true, message: 'Paiement enregistré.' });
    expect(calls.at(-1)).toMatchObject({ path: `/billing/invoices/${INVOICE}/payments`, body: { method: 'cash', amount: '10000.00', cashSessionId: SESSION } });
  });

  it('refuse les espèces sans session de caisse (aucun appel)', async () => {
    const { calls } = stubApi(() => undefined);
    const state = await recordPaymentAction({}, form({ invoiceId: INVOICE, method: 'cash', amount: '10000' }));
    expect(state.fieldErrors?.cashSessionId).toContain('session de caisse');
    expect(calls.some((c) => c.path.endsWith('/payments'))).toBe(false);
  });

  it('enregistre un autre mode avec sa référence', async () => {
    const { calls } = stubApi(() => okEnvelope({ ...CASH_PAYMENT, method: 'other' }, {}, 201));
    await recordPaymentAction({}, form({ invoiceId: INVOICE, method: 'other', amount: '5000', reference: 'CHQ-0042', cashSessionId: SESSION }));
    expect(calls.at(-1)?.body).toEqual({ method: 'other', amount: '5000.00', reference: 'CHQ-0042', cashSessionId: SESSION });
  });

  it('R9 : le mode « autre » exige une session de caisse ouverte (aucun appel)', async () => {
    const { calls } = stubApi(() => undefined);
    const state = await recordPaymentAction({}, form({ invoiceId: INVOICE, method: 'other', amount: '5000', reference: 'CHQ-0042' }));
    expect(state.fieldErrors?.cashSessionId).toContain('session de caisse');
    expect(calls.some((c) => c.path.endsWith('/payments'))).toBe(false);
  });

  it('R9 : cash_register_site_mismatch', async () => {
    stubApi(() => problem(422, 'cash_register_site_mismatch'));
    const state = await recordPaymentAction({}, form({ invoiceId: INVOICE, method: 'cash', amount: '100', cashSessionId: SESSION }));
    expect(state.message).toContain('même site');
  });

  it('R7 : montant avec décimales refusé en FCFA, amount_scale et payment_provider_unavailable expliqués', async () => {
    const { calls } = stubApi(() => problem(422, 'amount_scale'));
    const refused = await recordPaymentAction({}, form({ invoiceId: INVOICE, method: 'cash', amount: '100,5', cashSessionId: SESSION, currency: 'XOF' }));
    expect(refused.fieldErrors?.amount).toContain('sans décimales');
    expect(calls.some((c) => c.path.endsWith('/payments'))).toBe(false);
    const scale = await recordPaymentAction({}, form({ invoiceId: INVOICE, method: 'cash', amount: '100', cashSessionId: SESSION, currency: 'XOF' }));
    expect(scale.message).toContain('sans décimales');
    stubApi(() => problem(503, 'payment_provider_unavailable'));
    const down = await recordPaymentAction({}, form({ invoiceId: INVOICE, method: 'mobile_money', amount: '100', payerPhone: '77 123 45 67' }));
    expect(down.message).toContain('fournisseur de paiement');
  });

  it('amount_exceeds_balance affiche le reste dû', async () => {
    stubApi(() => problem(422, 'amount_exceeds_balance', { details: { balance: '2500.00' } }));
    const state = await recordPaymentAction({}, form({ invoiceId: INVOICE, method: 'other', amount: '9000', reference: 'x', currency: 'XOF', cashSessionId: SESSION }));
    expect(state.ok).toBe(false);
    expect(state.message).toContain(`2${NBSP}500${NBSP}FCFA`);
  });

  it('cash_session_not_open et invoice_not_payable', async () => {
    stubApi(() => problem(409, 'cash_session_not_open'));
    expect((await recordPaymentAction({}, form({ invoiceId: INVOICE, method: 'cash', amount: '100', cashSessionId: SESSION }))).message).toContain('session de caisse');
    stubApi(() => problem(409, 'invoice_not_payable'));
    expect((await recordPaymentAction({}, form({ invoiceId: INVOICE, method: 'cash', amount: '100', cashSessionId: SESSION }))).message).toContain('encaissée');
  });

  it('identifiant de facture invalide : demande invalide', async () => {
    stubApi(() => undefined);
    expect((await recordPaymentAction({}, form({ invoiceId: 'nope', method: 'cash', amount: '1' }))).ok).toBe(false);
  });
});

describe('recordPaymentAction : Mobile Money', () => {
  const MM = { invoiceId: INVOICE, method: 'mobile_money', amount: '25000', payerPhone: '77 123 45 67' };

  it('envoie le numéro normalisé dans le corps (jamais dans l\'URL) puis redirige vers checkoutUrl', async () => {
    const { calls } = stubApi(() =>
      okEnvelope({ payment: { ...CASH_PAYMENT, method: 'mobile_money', status: 'pending' }, checkoutUrl: 'https://pay.test/x', instructions: null }, {}, 201),
    );
    expect(await redirectOf(recordPaymentAction({}, form(MM)))).toBe('https://pay.test/x');
    const call = calls.at(-1);
    expect(call?.body).toEqual({ method: 'mobile_money', amount: '25000.00', payerPhone: '+221771234567' });
    expect(call?.url).not.toContain('771234567');
  });

  it('page sandbox : retour vers la facture', async () => {
    stubApi(() => okEnvelope({ payment: CASH_PAYMENT, checkoutUrl: 'http://localhost:3001/sandbox/paiement/sbx-ABCDEFGH', instructions: null }, {}, 201));
    expect(await redirectOf(recordPaymentAction({}, form(MM)))).toBe(`http://localhost:3001/sandbox/paiement/sbx-ABCDEFGH?retour=${encodeURIComponent(`/facturation/factures/${INVOICE}`)}`);
  });

  it('sans URL, affiche les instructions', async () => {
    stubApi(() => okEnvelope({ payment: CASH_PAYMENT, checkoutUrl: null, instructions: 'Validez sur votre téléphone.' }, {}, 201));
    expect(await recordPaymentAction({}, form(MM))).toMatchObject({ ok: true, extra: { instructions: 'Validez sur votre téléphone.' } });
  });

  it('payment_already_pending', async () => {
    stubApi(() => problem(409, 'payment_already_pending'));
    expect((await recordPaymentAction({}, form(MM))).message).toContain('en attente');
  });

  it('téléphone invalide : erreur de champ', async () => {
    stubApi(() => undefined);
    const state = await recordPaymentAction({}, form({ ...MM, payerPhone: '12' }));
    expect(state.fieldErrors?.payerPhone).toBeDefined();
  });
});

describe('refreshPaymentAction', () => {
  it('confirmé, échoué, en attente', async () => {
    stubApi(() => okEnvelope({ ...CASH_PAYMENT, method: 'mobile_money', status: 'succeeded' }));
    expect((await refreshPaymentAction({}, form({ paymentId: PAYMENT, invoiceId: INVOICE }))).message).toContain('Paiement confirmé');
    stubApi(() => okEnvelope({ ...CASH_PAYMENT, status: 'failed', failureReason: 'Solde insuffisant' }));
    const failed = await refreshPaymentAction({}, form({ paymentId: PAYMENT, invoiceId: INVOICE }));
    expect(failed).toMatchObject({ ok: false });
    expect(failed.message).toContain('Solde insuffisant');
    const { calls } = stubApi(() => okEnvelope({ ...CASH_PAYMENT, status: 'pending' }));
    expect((await refreshPaymentAction({}, form({ paymentId: PAYMENT, invoiceId: INVOICE }))).message).toContain('en attente');
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: `/billing/payments/${PAYMENT}/refresh` });
  });
  it('identifiants invalides et erreur API', async () => {
    expect((await refreshPaymentAction({}, form({ paymentId: 'x', invoiceId: INVOICE }))).ok).toBe(false);
    stubApi(() => problem(404, 'not_found'));
    expect((await refreshPaymentAction({}, form({ paymentId: PAYMENT, invoiceId: INVOICE }))).message).toContain('introuvable');
  });
});

describe('simulateSandboxPaymentAction', () => {
  const REF = 'sbx-1234ABCD';

  it('appelle le webhook de simulation puis revient à la page d\'origine', async () => {
    const { calls } = stubApi(() => okEnvelope({ ok: true }));
    const url = await redirectOf(simulateSandboxPaymentAction({}, form({ providerReference: REF, outcome: 'success', retour: `/facturation/factures/${INVOICE}` })));
    expect(url).toBe(`/facturation/factures/${INVOICE}`);
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: '/webhooks/payments/sandbox/simulate', body: { providerReference: REF, outcome: 'success' } });
    expect(calls.at(-1)?.authorization).toBeUndefined();
  });

  it('échec simulé', async () => {
    const { calls } = stubApi(() => okEnvelope({ ok: true }));
    await redirectOf(simulateSandboxPaymentAction({}, form({ providerReference: REF, outcome: 'failure' })));
    expect(calls.at(-1)?.body).toMatchObject({ outcome: 'failure' });
  });

  it('neutralise les redirections ouvertes du paramètre de retour', async () => {
    stubApi(() => okEnvelope({ ok: true }));
    for (const evil of ['//evil.test', 'https://evil.test', '/\\evil.test']) {
      expect(await redirectOf(simulateSandboxPaymentAction({}, form({ providerReference: REF, outcome: 'success', retour: evil })))).toBe('/');
    }
  });

  it('refuse une référence ou une issue invalide sans appeler l\'API', async () => {
    const { calls } = stubApi(() => undefined);
    expect((await simulateSandboxPaymentAction({}, form({ providerReference: '../x', outcome: 'success' }))).ok).toBe(false);
    expect((await simulateSandboxPaymentAction({}, form({ providerReference: REF, outcome: 'maybe' }))).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('404 en production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await expect(simulateSandboxPaymentAction({}, form({ providerReference: REF, outcome: 'success' }))).rejects.toThrow('NOT_FOUND');
  });

  it('erreur API (sandbox désactivé) : message en français', async () => {
    stubApi(() => problem(404, 'not_found'));
    expect((await simulateSandboxPaymentAction({}, form({ providerReference: REF, outcome: 'success' }))).message).toContain('introuvable');
  });
});

describe('abandonPaymentAction (R4)', () => {
  it('paiement annulé', async () => {
    const { calls } = stubApi(() => okEnvelope({ status: 'cancelled' }));
    const state = await abandonPaymentAction({}, form({ paymentId: PAYMENT, invoiceId: INVOICE }));
    expect(state).toMatchObject({ ok: true });
    expect(state.message).toContain('abandonné');
    expect(calls.at(-1)).toMatchObject({ path: `/billing/payments/${PAYMENT}/abandon` });
  });
  it('paiement finalement réglé', async () => {
    stubApi(() => okEnvelope({ status: 'succeeded' }));
    const state = await abandonPaymentAction({}, form({ paymentId: PAYMENT, invoiceId: INVOICE }));
    expect(state.ok).toBe(true);
    expect(state.message).toContain('finalement été confirmé');
  });
  it('statut inattendu, identifiants invalides et erreur API', async () => {
    stubApi(() => okEnvelope({ status: 'pending' }));
    expect((await abandonPaymentAction({}, form({ paymentId: PAYMENT, invoiceId: INVOICE }))).ok).toBe(false);
    expect((await abandonPaymentAction({}, form({ paymentId: 'x', invoiceId: INVOICE }))).ok).toBe(false);
    stubApi(() => problem(403, 'forbidden'));
    expect((await abandonPaymentAction({}, form({ paymentId: PAYMENT, invoiceId: INVOICE }))).ok).toBe(false);
  });
});
