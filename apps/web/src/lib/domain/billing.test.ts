import { describe, expect, it } from 'vitest';
import {
  buildPaymentInput,
  buildVoidInput,
  displayLabel,
  patientDisplay,
  receiptLabel,
  canIssue,
  canVoid,
  invoiceTotals,
  isPayable,
  parseDraftLines,
  pendingOnlinePayments,
  toCashRegister,
  toCashSession,
  toInvoiceDetail,
  toInvoicePayment,
  toInvoiceSummary,
  toOnlinePayment,
  toPriceList,
  toPriceListItem,
  toReceipt,
} from './billing';

const SUMMARY = {
  id: 'inv-1', number: 'FAC-2026-000012', status: 'issued', patientId: 'pat-1', siteId: 'site-1', appointmentId: null, currency: 'XOF',
  total: '30000.00', amountPaid: '5000.00', balance: '25000.00', issuedAt: '2026-10-04T08:00:00.000Z', createdAt: '2026-10-04T07:00:00.000Z',
};
const PAYMENT = {
  id: 'pay-1', method: 'mobile_money', amount: '25000.00', currency: 'XOF', status: 'pending', paidAt: null, cashSessionId: null, reference: null,
  provider: 'sandbox', checkoutUrl: 'http://localhost:3001/sandbox/paiement/ref', failureReason: null, createdAt: '2026-10-04T08:05:00.000Z',
};
const DETAIL = {
  ...SUMMARY,
  subtotal: '30000.00', notes: 'RAS', voidedAt: null, voidReason: null,
  patient: { id: 'pat-1', ipp: 'P26-0000001', fullName: 'Awa DIALLO' },
  lines: [{ id: 'l1', lineNo: 1, priceListItemId: 'it-1', category: 'consultation', description: 'Consultation', quantity: '1', unitPrice: '30000.00', lineTotal: '30000.00' }],
  payments: [PAYMENT],
};

describe('mappers de facturation', () => {
  it('toInvoiceSummary', () => {
    expect(toInvoiceSummary(SUMMARY)).toMatchObject({ number: 'FAC-2026-000012', status: 'issued', balance: '25000.00', appointmentId: null });
    expect(toInvoiceSummary(null)).toMatchObject({ number: null, status: 'draft', total: '0.00', issuedAt: null });
    expect(toInvoiceSummary({ ...SUMMARY, status: 'inconnu' }).status).toBe('draft');
  });
  it('toInvoiceDetail avec lignes, paiements et patient', () => {
    const detail = toInvoiceDetail(DETAIL);
    expect(detail.patient).toEqual({ id: 'pat-1', ipp: 'P26-0000001', fullName: 'Awa DIALLO', identityMasked: false });
    expect(detail.lines[0]).toMatchObject({ lineNo: 1, category: 'consultation', lineTotal: '30000.00' });
    expect(detail.payments[0]).toMatchObject({ method: 'mobile_money', status: 'pending', checkoutUrl: 'http://localhost:3001/sandbox/paiement/ref' });
    expect(toInvoiceDetail(undefined).lines).toEqual([]);
    expect(toInvoiceDetail({ lines: [{ category: 'x' }] }).lines[0]?.category).toBe('autre');
  });
  it('toInvoicePayment tolère les valeurs inconnues', () => {
    expect(toInvoicePayment({ method: '???', status: '???' })).toMatchObject({ method: 'other', status: 'pending', amount: '0.00' });
  });
  it('toOnlinePayment, toReceipt', () => {
    expect(toOnlinePayment({ payment: PAYMENT, checkoutUrl: 'https://x.test', instructions: 'Validez' })).toMatchObject({ checkoutUrl: 'https://x.test', instructions: 'Validez' });
    expect(toOnlinePayment({}).checkoutUrl).toBeNull();
    const receipt = toReceipt({ establishment: 'Clinique A', site: 'Plateau', invoice: DETAIL, printedAt: '2026-10-04T09:00:00.000Z' });
    expect(receipt).toMatchObject({ establishment: 'Clinique A', site: 'Plateau', printedAt: '2026-10-04T09:00:00.000Z' });
    expect(receipt.invoice.number).toBe('FAC-2026-000012');
  });
  it('grille tarifaire, caisses et sessions', () => {
    expect(toPriceList({ id: 'g', code: 'STD', name: 'Standard', currency: 'XOF', isDefault: true, isActive: true })).toMatchObject({ code: 'STD', isDefault: true });
    expect(toPriceListItem({ id: 'i', priceListId: 'g', code: 'C1', label: 'Consultation', category: 'consultation', unitPrice: '5000.00', isActive: true })).toMatchObject({ unitPrice: '5000.00' });
    expect(toPriceListItem({ category: 'zzz' }).category).toBe('autre');
    expect(toCashRegister({ id: 'r', siteId: 's', code: 'C1', name: 'Caisse 1', currency: 'XOF', isActive: true })).toMatchObject({ name: 'Caisse 1' });
    const session = toCashSession({ id: 's', cashRegisterId: 'r', status: 'closed', currency: 'XOF', openedBy: 'u1', openedAt: 'a', openingFloat: '10000.00', expectedTotal: '60000.00', closedBy: 'u1', closedAt: 'b', closingCounted: '59000.00', variance: '-1000.00', validatedBy: null, validatedAt: null });
    expect(session).toMatchObject({ status: 'closed', variance: '-1000.00', closingCounted: '59000.00', validatedBy: null });
    expect(toCashSession(null)).toMatchObject({ status: 'open', variance: null, closingCounted: null });
  });
});

describe('règles d\'affichage', () => {
  const detail = toInvoiceDetail(DETAIL);
  it('isPayable : émise ou partiellement payée avec un reste dû', () => {
    expect(isPayable(detail)).toBe(true);
    expect(isPayable({ ...detail, status: 'partially_paid' })).toBe(true);
    expect(isPayable({ ...detail, status: 'paid' })).toBe(false);
    expect(isPayable({ ...detail, status: 'draft' })).toBe(false);
    expect(isPayable({ ...detail, status: 'void' })).toBe(false);
    expect(isPayable({ ...detail, balance: '0.00' })).toBe(false);
  });
  it('canIssue seulement pour un brouillon', () => {
    expect(canIssue({ ...detail, status: 'draft' })).toBe(true);
    expect(canIssue(detail)).toBe(false);
  });
  it('canVoid : jamais si un paiement est réussi ou en attente', () => {
    expect(canVoid({ ...detail, status: 'draft', payments: [] })).toBe(true);
    expect(canVoid({ ...detail, payments: [{ ...detail.payments[0]!, status: 'failed' }] })).toBe(true);
    expect(canVoid(detail)).toBe(false);
    expect(canVoid({ ...detail, status: 'void', payments: [] })).toBe(false);
    expect(canVoid({ ...detail, status: 'paid', payments: [{ ...detail.payments[0]!, status: 'succeeded' }] })).toBe(false);
  });
  it('pendingOnlinePayments', () => {
    expect(pendingOnlinePayments(detail).map((p) => p.id)).toEqual(['pay-1']);
    expect(pendingOnlinePayments({ ...detail, payments: [{ ...detail.payments[0]!, method: 'cash' }] })).toEqual([]);
    expect(pendingOnlinePayments({ ...detail, payments: [{ ...detail.payments[0]!, status: 'succeeded' }] })).toEqual([]);
  });
});

describe('parseDraftLines', () => {
  const ITEM = '3f2b8c1e-1a2b-4c3d-8e9f-0123456789ab';
  it('convertit les lignes catalogue et libres au format API', () => {
    const result = parseDraftLines(
      JSON.stringify([
        { kind: 'catalog', priceListItemId: ITEM, quantity: '2' },
        { kind: 'free', description: 'Pansement', category: 'acte', unitPrice: '1 500', quantity: '1,5' },
      ]),
      true,
    );
    expect(result).toEqual({
      ok: true,
      lines: [
        { priceListItemId: ITEM, quantity: '2' },
        { description: 'Pansement', category: 'acte', unitPrice: '1500.00', quantity: '1.5' },
      ],
    });
  });
  it('refuse une ligne libre sans droit, une liste vide, un JSON invalide et des valeurs incorrectes', () => {
    const free = JSON.stringify([{ kind: 'free', description: 'X', category: 'autre', unitPrice: '10', quantity: '1' }]);
    expect(parseDraftLines(free, false)).toMatchObject({ ok: false });
    expect(parseDraftLines('[]', true)).toMatchObject({ ok: false });
    expect(parseDraftLines(undefined, true)).toMatchObject({ ok: false });
    expect(parseDraftLines('{pas du json', true)).toMatchObject({ ok: false });
    expect(parseDraftLines(JSON.stringify([{ kind: 'catalog', priceListItemId: '../x', quantity: '1' }]), true)).toMatchObject({ ok: false });
    expect(parseDraftLines(JSON.stringify([{ kind: 'catalog', priceListItemId: ITEM, quantity: '0' }]), true)).toMatchObject({ ok: false });
    expect(parseDraftLines(JSON.stringify([{ kind: 'free', description: 'A', category: 'autre', unitPrice: '-1', quantity: '1' }]), true)).toMatchObject({ ok: false });
    expect(parseDraftLines(JSON.stringify([{ kind: 'free', description: 'A', category: 'zzz', unitPrice: '1', quantity: '1' }]), true)).toMatchObject({ ok: false });
    expect(parseDraftLines(JSON.stringify(['x']), true)).toMatchObject({ ok: false });
    expect(parseDraftLines(JSON.stringify(Array.from({ length: 101 }, () => ({ kind: 'catalog', priceListItemId: ITEM, quantity: '1' }))), true)).toMatchObject({ ok: false });
  });
});

describe('invoiceTotals', () => {
  it('calcule les totaux d\'aperçu côté interface', () => {
    expect(invoiceTotals([{ unitPrice: '25000.00', quantity: '2' }, { unitPrice: '1500.00', quantity: '0.5' }])).toBe('50750.00');
    expect(invoiceTotals([])).toBe('0.00');
  });
});

describe('buildPaymentInput', () => {
  const SESSION = '3f2b8c1e-1a2b-4c3d-8e9f-0123456789ab';
  it('espèces : exige une session de caisse', () => {
    expect(buildPaymentInput({ method: 'cash', amount: '5 000', cashSessionId: SESSION }, 'SN')).toEqual({
      ok: true,
      body: { method: 'cash', amount: '5000.00', cashSessionId: SESSION },
    });
    const missing = buildPaymentInput({ method: 'cash', amount: '5000' }, 'SN');
    expect(missing).toMatchObject({ ok: false });
    expect(missing.ok === false && missing.fieldErrors.cashSessionId).toBeDefined();
  });
  it('Mobile Money : normalise le téléphone avec le pays de l\'établissement', () => {
    const result = buildPaymentInput({ method: 'mobile_money', amount: '25000', payerPhone: '77 123 45 67' }, 'SN');
    expect(result).toEqual({ ok: true, body: { method: 'mobile_money', amount: '25000.00', payerPhone: '+221771234567' } });
  });
  it('Mobile Money : téléphone absent ou invalide', () => {
    expect(buildPaymentInput({ method: 'mobile_money', amount: '1000' }, 'SN')).toMatchObject({ ok: false, fieldErrors: { payerPhone: expect.any(String) } });
    expect(buildPaymentInput({ method: 'mobile_money', amount: '1000', payerPhone: '12' }, 'SN')).toMatchObject({ ok: false, fieldErrors: { payerPhone: expect.any(String) } });
  });
  it('autre mode : exige une référence', () => {
    const SESSION = '8e2b8c1e-1a2b-4c3d-8e9f-0123456789ab';
    expect(buildPaymentInput({ method: 'other', amount: '1000', reference: ' CHQ-123 ', cashSessionId: SESSION }, 'SN')).toEqual({ ok: true, body: { method: 'other', amount: '1000.00', reference: 'CHQ-123', cashSessionId: SESSION } });
    expect(buildPaymentInput({ method: 'other', amount: '1000', cashSessionId: SESSION }, 'SN')).toMatchObject({ ok: false, fieldErrors: { reference: expect.any(String) } });
  });
  it('refuse un mode inconnu, un montant nul ou invalide', () => {
    expect(buildPaymentInput({ method: 'bitcoin', amount: '1000' }, 'SN')).toMatchObject({ ok: false, fieldErrors: { method: expect.any(String) } });
    expect(buildPaymentInput({ method: 'other', amount: '0', reference: 'x' }, 'SN')).toMatchObject({ ok: false, fieldErrors: { amount: expect.any(String) } });
    expect(buildPaymentInput({ method: 'other', amount: 'abc', reference: 'x' }, 'SN')).toMatchObject({ ok: false, fieldErrors: { amount: expect.any(String) } });
  });
});

describe('R2 : lignes sensibles', () => {
  const line = { description: 'Test VIH', category: 'examen' as const, isSensitive: true, labelMasked: false, printLabel: 'Examen biologique' };
  it('affiche le libellé masqué quand labelMasked, sinon la description', () => {
    expect(displayLabel({ ...line, labelMasked: true })).toBe('Examen biologique');
    expect(displayLabel({ ...line, labelMasked: true, printLabel: null })).toBe('Examen');
    expect(displayLabel(line)).toBe('Test VIH');
  });
  it('libellés neutres par catégorie', () => {
    const neutral = (category: 'consultation' | 'acte' | 'examen' | 'medicament' | 'autre') => displayLabel({ description: 'x', category, labelMasked: true, printLabel: null });
    expect([neutral('consultation'), neutral('acte'), neutral('examen'), neutral('medicament'), neutral('autre')]).toEqual(['Consultation', 'Acte médical', 'Examen', 'Médicament', 'Prestation']);
  });
  it('le reçu utilise exclusivement le libellé imprimable d\'une ligne sensible', () => {
    expect(receiptLabel(line)).toBe('Examen biologique');
    expect(receiptLabel({ ...line, printLabel: null })).toBe('Examen');
    expect(receiptLabel({ ...line, isSensitive: false })).toBe('Test VIH');
    expect(JSON.stringify(receiptLabel(line))).not.toContain('VIH');
  });
  it('mappe isSensitive, printLabel et labelMasked (lignes et grille)', () => {
    const detail = toInvoiceDetail({ ...DETAIL, lines: [{ category: 'examen', description: 'Examen', isSensitive: true, printLabel: 'Bilan', labelMasked: true }] });
    expect(detail.lines[0]).toMatchObject({ isSensitive: true, printLabel: 'Bilan', labelMasked: true });
    expect(toPriceListItem({ isSensitive: true, printLabel: 'Bilan' })).toMatchObject({ isSensitive: true, printLabel: 'Bilan', labelMasked: false });
    expect(toPriceListItem({}).printLabel).toBeNull();
  });
});

describe('R3 : identité masquée', () => {
  it('affiche « Patient {IPP} » sans nom', () => {
    const detail = toInvoiceDetail({ ...DETAIL, patient: { id: 'pat-1', ipp: 'P26-0000001', fullName: 'Ne doit pas fuiter', identityMasked: true } });
    expect(detail.patient.fullName).toBeNull();
    expect(patientDisplay(detail.patient)).toBe('Patient P26-0000001');
    expect(patientDisplay({ id: 'p', ipp: '', fullName: null, identityMasked: true })).toBe('Patient');
    expect(patientDisplay({ id: 'p', ipp: 'P1', fullName: 'Awa DIALLO', identityMasked: false })).toBe('Awa DIALLO');
  });
});

describe('R4 / R5 : paiements annulés et reçu annulé', () => {
  it('conserve le statut cancelled et l\'anomalie, et autorise l\'annulation de la facture', () => {
    expect(toInvoicePayment({ status: 'cancelled', anomaly: 'overpaid' })).toMatchObject({ status: 'cancelled', anomaly: 'overpaid' });
    expect(canVoid({ status: 'issued', payments: [toInvoicePayment({ status: 'cancelled' }), toInvoicePayment({ status: 'failed' })] })).toBe(true);
  });
  it('reçu : voided vient du contrat ou du statut', () => {
    expect(toReceipt({ invoice: DETAIL, voided: true }).voided).toBe(true);
    expect(toReceipt({ invoice: { ...DETAIL, status: 'void' } }).voided).toBe(true);
    expect(toReceipt({ invoice: DETAIL }).voided).toBe(false);
  });
});

describe('R6 : annulation codifiée', () => {
  it('exige un motif connu, commentaire facultatif de 300 caractères au plus', () => {
    expect(buildVoidInput({ reasonCode: 'wrong_patient' })).toEqual({ ok: true, body: { reasonCode: 'wrong_patient' } });
    expect(buildVoidInput({ reasonCode: 'other', comment: ' ok ' })).toEqual({ ok: true, body: { reasonCode: 'other', comment: 'ok' } });
    expect(buildVoidInput({}).ok).toBe(false);
    expect(buildVoidInput({ reasonCode: 'toString' }).ok).toBe(false);
    expect(buildVoidInput({ reasonCode: 'other', comment: 'x'.repeat(300) }).ok).toBe(true);
    expect(buildVoidInput({ reasonCode: 'other', comment: 'x'.repeat(301) }).ok).toBe(false);
  });
});

describe('R7 : FCFA', () => {
  it('totaux d\'aperçu arrondis à l\'unité', () => {
    expect(invoiceTotals([{ unitPrice: '1001.00', quantity: '0.5' }], 'XOF')).toBe('501.00');
  });
  it('lignes libres : prix décimal refusé en XOF, accepté en EUR', () => {
    const lines = JSON.stringify([{ kind: 'free', description: 'Pansement', category: 'acte', unitPrice: '1,5', quantity: '1' }]);
    expect(parseDraftLines(lines, true, 'XOF').ok).toBe(false);
    expect(parseDraftLines(lines, true, 'EUR').ok).toBe(true);
  });
});

describe('R6/R8 : lectures du contrat', () => {
  it('voidReasonCode connu seulement, forceClosed booléen', () => {
    expect(toInvoiceDetail({ ...DETAIL, voidReasonCode: 'duplicate', voidReason: 'saisi deux fois' })).toMatchObject({ voidReasonCode: 'duplicate', voidReason: 'saisi deux fois' });
    expect(toInvoiceDetail({ ...DETAIL, voidReasonCode: 'inconnu' }).voidReasonCode).toBeNull();
    expect(toCashSession({ forceClosed: true }).forceClosed).toBe(true);
    expect(toCashSession({}).forceClosed).toBe(false);
  });
});
