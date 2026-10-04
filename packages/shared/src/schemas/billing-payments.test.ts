import { describe, expect, it } from 'vitest';
import {
  closeCashSessionSchema,
  createInvoiceSchema,
  createPriceListItemSchema,
  sandboxSimulationSchema,
  moneyAmount,
  openCashSessionSchema,
  positiveMoneyAmount,
  recordPaymentSchema,
  voidInvoiceSchema,
} from './index';

const UUID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

describe('montants décimaux (chaînes, jamais de flottant)', () => {
  it('accepte une chaîne décimale à 2 décimales au plus', () => {
    expect(moneyAmount.safeParse('25000').success).toBe(true);
    expect(moneyAmount.safeParse('25000.50').success).toBe(true);
    expect(moneyAmount.safeParse('0.00').success).toBe(true);
  });

  it('refuse les nombres JSON, les signes, les séparateurs et les 3 décimales', () => {
    expect(moneyAmount.safeParse(25000).success).toBe(false);
    expect(moneyAmount.safeParse('-1').success).toBe(false);
    expect(moneyAmount.safeParse('1,5').success).toBe(false);
    expect(moneyAmount.safeParse('1.234').success).toBe(false);
    expect(moneyAmount.safeParse('1e3').success).toBe(false);
    expect(moneyAmount.safeParse('').success).toBe(false);
  });

  it('positiveMoneyAmount refuse zéro', () => {
    expect(positiveMoneyAmount.safeParse('0.00').success).toBe(false);
    expect(positiveMoneyAmount.safeParse('0.01').success).toBe(true);
  });
});

describe('createInvoiceSchema', () => {
  const base = { patientId: UUID, siteId: UUID };

  it('accepte une ligne de grille et une ligne libre, quantité 1 par défaut', () => {
    const parsed = createInvoiceSchema.parse({
      ...base,
      lines: [{ priceListItemId: UUID }, { description: 'Pansement', category: 'acte', unitPrice: '1500.00', quantity: '2' }],
    });
    expect(parsed.lines[0]).toMatchObject({ priceListItemId: UUID, quantity: '1' });
    expect(parsed.lines[1]).toMatchObject({ description: 'Pansement', quantity: '2' });
  });

  it('refuse une facture sans ligne, une quantité nulle et un prix en nombre', () => {
    expect(createInvoiceSchema.safeParse({ ...base, lines: [] }).success).toBe(false);
    expect(createInvoiceSchema.safeParse({ ...base, lines: [{ priceListItemId: UUID, quantity: '0' }] }).success).toBe(false);
    expect(createInvoiceSchema.safeParse({ ...base, lines: [{ description: 'x', category: 'acte', unitPrice: 15 }] }).success).toBe(false);
  });

  it('refuse plus de 100 lignes', () => {
    const lines = Array.from({ length: 101 }, () => ({ priceListItemId: UUID }));
    expect(createInvoiceSchema.safeParse({ ...base, lines }).success).toBe(false);
  });
});

describe('recordPaymentSchema', () => {
  it('exige une session de caisse pour les espèces', () => {
    expect(recordPaymentSchema.safeParse({ method: 'cash', amount: '1000.00' }).success).toBe(false);
    expect(recordPaymentSchema.safeParse({ method: 'cash', amount: '1000.00', cashSessionId: UUID }).success).toBe(true);
  });

  it('exige un téléphone E.164 pour le Mobile Money', () => {
    expect(recordPaymentSchema.safeParse({ method: 'mobile_money', amount: '1000.00' }).success).toBe(false);
    expect(recordPaymentSchema.safeParse({ method: 'mobile_money', amount: '1000.00', payerPhone: '0771234567' }).success).toBe(false);
    expect(recordPaymentSchema.safeParse({ method: 'mobile_money', amount: '1000.00', payerPhone: '+221771234567' }).success).toBe(true);
  });

  it('refuse un montant nul et un mode inconnu', () => {
    expect(recordPaymentSchema.safeParse({ method: 'cash', amount: '0', cashSessionId: UUID }).success).toBe(false);
    expect(recordPaymentSchema.safeParse({ method: 'bitcoin', amount: '10' }).success).toBe(false);
  });
});

describe('autres contrats de facturation et de caisse', () => {
  it('valide la grille tarifaire', () => {
    expect(createPriceListItemSchema.safeParse({ code: 'CONS-GEN', label: 'Consultation générale', category: 'consultation', unitPrice: '5000.00' }).success).toBe(true);
    expect(createPriceListItemSchema.safeParse({ code: 'x y', label: 'a', category: 'inconnue', unitPrice: '1' }).success).toBe(false);
  });

  it('exige un motif d’annulation', () => {
    expect(voidInvoiceSchema.safeParse({ reason: 'ab' }).success).toBe(false);
    expect(voidInvoiceSchema.safeParse({ reason: 'Erreur de saisie' }).success).toBe(true);
  });

  it('valide l’ouverture et la clôture de caisse', () => {
    expect(openCashSessionSchema.safeParse({ cashRegisterId: UUID, openingFloat: '10000.00' }).success).toBe(true);
    expect(openCashSessionSchema.safeParse({ cashRegisterId: UUID, openingFloat: -5 }).success).toBe(false);
    expect(closeCashSessionSchema.safeParse({ countedAmount: '12500.00' }).success).toBe(true);
    expect(closeCashSessionSchema.safeParse({}).success).toBe(false);
  });

  it('valide la simulation sandbox', () => {
    expect(sandboxSimulationSchema.safeParse({ attemptId: UUID, outcome: 'success' }).success).toBe(true);
    expect(sandboxSimulationSchema.safeParse({ attemptId: UUID, outcome: 'maybe' }).success).toBe(false);
  });
});
