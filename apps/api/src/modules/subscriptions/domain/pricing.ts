import type { BillingPeriod, SaasInvoiceKind, SubscriptionStatus } from '@ghmt/shared';
import { applyRate, fromMinor, prorate, toMinor } from './money';
import { addBillingPeriod, addDays } from './period';

/** Émission de la facture de renouvellement/conversion à J-7 de l'échéance (docs/05 A8). */
export const INVOICE_LEAD_DAYS = 7;
/** Échéance de paiement d'une facture après son émission. */
export const INVOICE_DUE_DAYS = 7;

export interface PlanPrice {
  readonly code: string;
  readonly name: string;
  readonly priceMonthly: string;
  readonly priceYearly: string;
  readonly currency: string;
}

export interface InvoiceLineDraft {
  readonly position: number;
  readonly description: string;
  readonly quantity: number;
  readonly unitPrice: string;
  readonly amount: string;
}

export interface InvoiceDraft {
  readonly subtotal: string;
  readonly taxRate: string;
  readonly taxAmount: string;
  readonly total: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly currency: string;
  readonly lines: readonly InvoiceLineDraft[];
}

const PERIOD_LABEL: Record<BillingPeriod, string> = { monthly: 'mensuel', yearly: 'annuel' };
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function priceFor(plan: Pick<PlanPrice, 'priceMonthly' | 'priceYearly'>, period: BillingPeriod): string {
  return period === 'monthly' ? plan.priceMonthly : plan.priceYearly;
}

/** Le XAF est à parité fixe avec le XOF (docs/05 A1) ; toute autre devise est facturée dans la devise du plan. */
export function invoiceCurrency(planCurrency: string, tenantCurrency: string): string {
  return tenantCurrency === 'XAF' && planCurrency === 'XOF' ? 'XAF' : planCurrency;
}

function withTax(subtotalMinor: bigint, taxRate: string): { subtotal: string; taxAmount: string; total: string } {
  const tax = applyRate(subtotalMinor, taxRate);
  return { subtotal: fromMinor(subtotalMinor), taxAmount: fromMinor(tax), total: fromMinor(subtotalMinor + tax) };
}

export function buildInvoiceDraft(input: {
  readonly plan: PlanPrice;
  readonly billingPeriod: BillingPeriod;
  readonly taxRate: string;
  readonly periodStart: Date;
  readonly currency: string;
}): InvoiceDraft {
  const unitPrice = fromMinor(toMinor(priceFor(input.plan, input.billingPeriod)));
  const amounts = withTax(toMinor(unitPrice), input.taxRate);
  return {
    ...amounts,
    taxRate: input.taxRate,
    periodStart: input.periodStart,
    periodEnd: addBillingPeriod(input.periodStart, input.billingPeriod),
    currency: input.currency,
    lines: [{ position: 1, description: `Abonnement ${input.plan.name} — ${PERIOD_LABEL[input.billingPeriod]}`, quantity: 1, unitPrice, amount: unitPrice }],
  };
}

/** Prorata d'une montée en gamme : (nouveau − ancien) × temps restant / durée de la période ; `null` si rien à facturer. */
export function buildProrataDraft(input: {
  readonly from: PlanPrice;
  readonly to: PlanPrice;
  readonly billingPeriod: BillingPeriod;
  readonly taxRate: string;
  readonly now: Date;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly currency: string;
}): InvoiceDraft | null {
  const delta = toMinor(priceFor(input.to, input.billingPeriod)) - toMinor(priceFor(input.from, input.billingPeriod));
  const total = input.periodEnd.getTime() - input.periodStart.getTime();
  const remaining = Math.max(0, input.periodEnd.getTime() - input.now.getTime());
  if (delta <= 0n || total <= 0 || remaining === 0) return null;

  const subtotal = prorate(delta, remaining, total);
  if (subtotal <= 0n) return null;
  const days = Math.ceil(remaining / MS_PER_DAY);
  const unitPrice = fromMinor(subtotal);
  return {
    ...withTax(subtotal, input.taxRate),
    taxRate: input.taxRate,
    periodStart: input.now,
    periodEnd: input.periodEnd,
    currency: input.currency,
    lines: [
      {
        position: 1,
        description: `Changement d’offre ${input.from.name} → ${input.to.name} — prorata ${days} j`,
        quantity: 1,
        unitPrice,
        amount: unitPrice,
      },
    ],
  };
}

export interface InvoiceDueSnapshot {
  readonly status: SubscriptionStatus;
  readonly cancelAtPeriodEnd: boolean;
  readonly currentPeriodEnd: Date;
  readonly trialEndsAt: Date | null;
}

/** Type de facture à émettre à l'instant `now` (idempotence assurée par l'index unique en base). */
export function invoiceDueKind(s: InvoiceDueSnapshot, now: Date): Extract<SaasInvoiceKind, 'renewal' | 'conversion'> | null {
  if (s.status === 'trial' && s.trialEndsAt && now >= addDays(s.trialEndsAt, -INVOICE_LEAD_DAYS)) return 'conversion';
  // past_due et grace : la facture manquante (job interrompu) est émise pour que le tenant puisse régulariser.
  const renewable = s.status === 'active' || s.status === 'past_due' || s.status === 'grace';
  if (renewable && !s.cancelAtPeriodEnd && now >= addDays(s.currentPeriodEnd, -INVOICE_LEAD_DAYS)) return 'renewal';
  return null;
}
