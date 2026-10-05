import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { okEnvelope, problem } from '@/lib/api/test-helpers';

vi.mock('next/navigation', async () => (await import('./test-kit')).navigationMock());
vi.mock('next/cache', async () => (await import('./test-kit')).cacheMock());
vi.mock('next/headers', async () => (await import('./test-kit')).headersMock());

import { createInvoiceAction, issueInvoiceAction, voidInvoiceAction } from './billing-invoices';
import { form, ME, redirectOf, stubApi } from './test-kit';

const PATIENT = '3f2b8c1e-1a2b-4c3d-8e9f-0123456789ab';
const SITE = '4a2b8c1e-1a2b-4c3d-8e9f-0123456789ab';
const ITEM = '5b2b8c1e-1a2b-4c3d-8e9f-0123456789ab';
const INVOICE = '6c2b8c1e-1a2b-4c3d-8e9f-0123456789ab';
const APPT = '7d2b8c1e-1a2b-4c3d-8e9f-0123456789ab';

const CATALOG_LINES = JSON.stringify([{ kind: 'catalog', priceListItemId: ITEM, quantity: '2' }]);
const FREE_LINES = JSON.stringify([{ kind: 'free', description: 'Pansement', category: 'acte', unitPrice: '1 500', quantity: '1' }]);

beforeEach(() => {
  vi.stubEnv('API_URL', 'http://api.test/api/v1');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('createInvoiceAction', () => {
  it('crée le brouillon et redirige vers le détail (sans émettre)', async () => {
    const { calls } = stubApi((c) => (c.path === '/billing/invoices' ? okEnvelope({ id: INVOICE }, {}, 201) : undefined));
    const url = await redirectOf(
      createInvoiceAction({}, form({ patientId: PATIENT, siteId: SITE, appointmentId: APPT, lines: CATALOG_LINES, notes: ' RAS ', intent: 'draft' })),
    );
    expect(url).toBe(`/facturation/factures/${INVOICE}`);
    const create = calls.find((c) => c.path === '/billing/invoices');
    expect(create?.body).toEqual({ patientId: PATIENT, siteId: SITE, appointmentId: APPT, notes: 'RAS', lines: [{ priceListItemId: ITEM, quantity: '2' }] });
    expect(calls.some((c) => c.path.endsWith('/issue'))).toBe(false);
    expect(create?.url).not.toContain(PATIENT);
  });

  it('crée puis émet avec l\'intention « issue »', async () => {
    const { calls } = stubApi((c) => (c.path === '/billing/invoices' ? okEnvelope({ id: INVOICE }, {}, 201) : okEnvelope({ id: INVOICE })));
    await redirectOf(createInvoiceAction({}, form({ patientId: PATIENT, siteId: SITE, lines: CATALOG_LINES, intent: 'issue' })));
    expect(calls.map((c) => c.path)).toContain(`/billing/invoices/${INVOICE}/issue`);
  });

  it('redirige vers le détail même si l\'émission échoue (le brouillon existe)', async () => {
    stubApi((c) => (c.path === '/billing/invoices' ? okEnvelope({ id: INVOICE }, {}, 201) : problem(409, 'invoice_not_draft')));
    expect(await redirectOf(createInvoiceAction({}, form({ patientId: PATIENT, siteId: SITE, lines: CATALOG_LINES, intent: 'issue' })))).toBe(`/facturation/factures/${INVOICE}`);
  });

  it('ligne libre refusée sans billing:invoice:update (aucun appel de création)', async () => {
    const { calls } = stubApi(() => undefined);
    const state = await createInvoiceAction({}, form({ patientId: PATIENT, siteId: SITE, lines: FREE_LINES }));
    expect(state.ok).toBe(false);
    expect(state.fieldErrors?.lines).toContain('ligne libre');
    expect(calls.some((c) => c.path === '/billing/invoices')).toBe(false);
  });

  it('ligne libre acceptée avec billing:invoice:update', async () => {
    const { calls } = stubApi(() => okEnvelope({ id: INVOICE }, {}, 201), { ...ME, permissions: [...ME.permissions, 'billing:invoice:update'] });
    await redirectOf(createInvoiceAction({}, form({ patientId: PATIENT, siteId: SITE, lines: FREE_LINES })));
    expect(calls.find((c) => c.path === '/billing/invoices')?.body).toMatchObject({ lines: [{ description: 'Pansement', unitPrice: '1500.00', category: 'acte', quantity: '1' }] });
  });

  it('FCFA : refuse un prix de ligne libre avec décimales (aucun appel)', async () => {
    const { calls } = stubApi(() => okEnvelope({ id: INVOICE }, {}, 201), { ...ME, permissions: [...ME.permissions, 'billing:invoice:update'] });
    const lines = JSON.stringify([{ kind: 'free', description: 'Pansement', category: 'acte', unitPrice: '1500,5', quantity: '1' }]);
    const state = await createInvoiceAction({}, form({ patientId: PATIENT, siteId: SITE, lines, currency: 'XOF' }));
    expect(state.fieldErrors?.lines).toContain('sans décimales');
    expect(calls.some((c) => c.path === '/billing/invoices')).toBe(false);
  });

  it('patient ou site manquant : messages explicites', async () => {
    stubApi(() => undefined);
    const state = await createInvoiceAction({}, form({ lines: CATALOG_LINES }));
    expect(state.fieldErrors?.patientId).toContain('patient');
    expect(state.fieldErrors?.siteId).toContain('site');
  });

  it('403 free_line_forbidden renvoyé par l\'API', async () => {
    stubApi(() => problem(403, 'free_line_forbidden'), { ...ME, permissions: [...ME.permissions, 'billing:invoice:update'] });
    expect((await createInvoiceAction({}, form({ patientId: PATIENT, siteId: SITE, lines: FREE_LINES }))).message).toContain('ligne libre');
  });

  it('réponse sans identifiant : retour à la liste', async () => {
    stubApi(() => okEnvelope({}, {}, 201));
    expect(await redirectOf(createInvoiceAction({}, form({ patientId: PATIENT, siteId: SITE, lines: CATALOG_LINES })))).toBe('/facturation/factures');
  });
});

describe('issueInvoiceAction / voidInvoiceAction', () => {
  it('émet une facture', async () => {
    const { calls } = stubApi(() => okEnvelope({ id: INVOICE }));
    expect((await issueInvoiceAction({}, form({ invoiceId: INVOICE }))).message).toContain('Facture émise');
    expect(calls.at(-1)?.path).toBe(`/billing/invoices/${INVOICE}/issue`);
  });
  it('rejette un identifiant invalide et propage les erreurs API', async () => {
    stubApi(() => problem(409, 'invoice_not_draft'));
    expect((await issueInvoiceAction({}, form({ invoiceId: 'x' }))).ok).toBe(false);
    expect((await issueInvoiceAction({}, form({ invoiceId: INVOICE }))).message).toContain('brouillon');
  });
  it('annule avec un motif obligatoire', async () => {
    const { calls } = stubApi(() => okEnvelope({ id: INVOICE }));
    const missing = await voidInvoiceAction({}, form({ invoiceId: INVOICE, reasonCode: 'inconnu' }));
    expect(missing.fieldErrors?.reasonCode).toBeDefined();
    expect(calls.some((c) => c.path.endsWith('/void'))).toBe(false);
    expect((await voidInvoiceAction({}, form({ invoiceId: INVOICE, reasonCode: 'duplicate' }))).message).toBe('Facture annulée.');
    expect(calls.at(-1)?.body).toEqual({ reasonCode: 'duplicate' });
    await voidInvoiceAction({}, form({ invoiceId: INVOICE, reasonCode: 'other', comment: ' erreur de caisse ' }));
    expect(calls.at(-1)?.body).toEqual({ reasonCode: 'other', comment: 'erreur de caisse' });
  });
  it('refuse un commentaire de plus de 300 caractères (aucun appel)', async () => {
    const { calls } = stubApi(() => okEnvelope({ id: INVOICE }));
    const state = await voidInvoiceAction({}, form({ invoiceId: INVOICE, reasonCode: 'other', comment: 'x'.repeat(301) }));
    expect(state.fieldErrors?.comment).toContain('300');
    expect(calls.some((c) => c.path.endsWith('/void'))).toBe(false);
  });
  it('409 invoice_has_payments à l\'annulation', async () => {
    stubApi(() => problem(409, 'invoice_has_payments'));
    expect((await voidInvoiceAction({}, form({ invoiceId: INVOICE, reasonCode: 'wrong_price' }))).message).toContain('encaissements');
    expect((await voidInvoiceAction({}, form({ invoiceId: 'x', reasonCode: 'wrong_price' }))).ok).toBe(false);
  });
});
