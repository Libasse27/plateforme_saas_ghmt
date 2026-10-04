import { describe, expect, it } from 'vitest';
import { buildInvoiceDraft, buildProrataDraft, invoiceCurrency, invoiceDueKind, priceFor } from './pricing';

const d = (iso: string): Date => new Date(iso);
const plan = (code: string, monthly: string, yearly: string) => ({ code, name: code.toUpperCase(), priceMonthly: monthly, priceYearly: yearly, currency: 'XOF' });

describe('priceFor', () => {
  it('choisit le prix selon la périodicité', () => {
    expect(priceFor(plan('basic', '25000.00', '250000.00'), 'monthly')).toBe('25000.00');
    expect(priceFor(plan('basic', '25000.00', '250000.00'), 'yearly')).toBe('250000.00');
  });
});

describe('invoiceCurrency', () => {
  it('garde la devise du plan, sauf XAF à parité avec le XOF', () => {
    expect(invoiceCurrency('XOF', 'XAF')).toBe('XAF');
    expect(invoiceCurrency('XOF', 'XOF')).toBe('XOF');
    expect(invoiceCurrency('XOF', 'USD')).toBe('XOF');
  });
});

describe('buildInvoiceDraft (renouvellement / conversion)', () => {
  it('calcule sous-total, TVA et total à partir du prix du plan', () => {
    const draft = buildInvoiceDraft({
      plan: plan('standard', '75000.00', '750000.00'),
      billingPeriod: 'monthly',
      taxRate: '0.1800',
      periodStart: d('2026-11-01T00:00:00Z'),
      currency: 'XOF',
    });
    expect(draft.subtotal).toBe('75000.00');
    expect(draft.taxAmount).toBe('13500.00');
    expect(draft.total).toBe('88500.00');
    expect(draft.periodEnd).toEqual(d('2026-12-01T00:00:00Z'));
    expect(draft.lines).toEqual([
      { position: 1, description: 'Abonnement STANDARD — mensuel', quantity: 1, unitPrice: '75000.00', amount: '75000.00' },
    ]);
  });

  it('gère l’annuel et un taux nul', () => {
    const draft = buildInvoiceDraft({
      plan: plan('basic', '25000.00', '250000.00'),
      billingPeriod: 'yearly',
      taxRate: '0.0000',
      periodStart: d('2026-11-01T00:00:00Z'),
      currency: 'XOF',
    });
    expect(draft.total).toBe('250000.00');
    expect(draft.taxAmount).toBe('0.00');
    expect(draft.periodEnd).toEqual(d('2027-11-01T00:00:00Z'));
  });
});

describe('buildProrataDraft (upgrade)', () => {
  it('facture (nouveau − ancien) × jours restants / jours de la période', () => {
    const draft = buildProrataDraft({
      from: plan('basic', '25000.00', '250000.00'),
      to: plan('standard', '75000.00', '750000.00'),
      billingPeriod: 'monthly',
      taxRate: '0.1800',
      now: d('2026-10-21T00:00:00Z'),
      periodStart: d('2026-10-01T00:00:00Z'),
      periodEnd: d('2026-10-31T00:00:00Z'),
      currency: 'XOF',
    });
    // 50 000 × 10 / 30 = 16 666,67 ; TVA 18 % = 3 000,00 (arrondi) ; total 19 666,67
    expect(draft?.subtotal).toBe('16666.67');
    expect(draft?.taxAmount).toBe('3000.00');
    expect(draft?.total).toBe('19666.67');
    expect(draft?.periodStart).toEqual(d('2026-10-21T00:00:00Z'));
    expect(draft?.periodEnd).toEqual(d('2026-10-31T00:00:00Z'));
  });

  it('ne facture rien quand le montant est nul (fin de période atteinte)', () => {
    const draft = buildProrataDraft({
      from: plan('basic', '25000.00', '250000.00'),
      to: plan('standard', '75000.00', '750000.00'),
      billingPeriod: 'monthly',
      taxRate: '0.1800',
      now: d('2026-10-31T00:00:00Z'),
      periodStart: d('2026-10-01T00:00:00Z'),
      periodEnd: d('2026-10-31T00:00:00Z'),
      currency: 'XOF',
    });
    expect(draft).toBeNull();
  });
});

describe('invoiceDueKind', () => {
  const base = { cancelAtPeriodEnd: false, currentPeriodEnd: d('2026-11-01T00:00:00Z'), trialEndsAt: null as Date | null };
  it('émet la facture de renouvellement à J-7 d’un abonnement actif', () => {
    expect(invoiceDueKind({ ...base, status: 'active' }, d('2026-10-24T23:59:59Z'))).toBeNull();
    expect(invoiceDueKind({ ...base, status: 'active' }, d('2026-10-25T00:00:00Z'))).toBe('renewal');
  });

  it('émet la facture de conversion à J-7 de la fin d’essai', () => {
    const trial = { ...base, status: 'trial' as const, trialEndsAt: d('2026-11-03T00:00:00Z') };
    expect(invoiceDueKind(trial, d('2026-10-26T23:59:59Z'))).toBeNull();
    expect(invoiceDueKind(trial, d('2026-10-27T00:00:00Z'))).toBe('conversion');
  });

  it('n’émet rien pour une résiliation programmée ni pour les autres statuts', () => {
    expect(invoiceDueKind({ ...base, status: 'active', cancelAtPeriodEnd: true }, d('2026-10-30T00:00:00Z'))).toBeNull();
    expect(invoiceDueKind({ ...base, status: 'suspended' }, d('2026-10-30T00:00:00Z'))).toBeNull();
  });
});
