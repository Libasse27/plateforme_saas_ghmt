import type { InvoiceStatus } from '@ghmt/shared';
import { subtractMoney, type Money } from '../../../common/money/money';

/** Statut d'une facture émise (ni brouillon ni annulée) d'après le montant encaissé. */
export function statusAfterPayments(total: Money, amountPaid: Money): Extract<InvoiceStatus, 'issued' | 'partially_paid' | 'paid'> {
  if (amountPaid.greaterThanOrEqualTo(total)) return 'paid';
  return amountPaid.greaterThan(0) ? 'partially_paid' : 'issued';
}

export function balanceOf(total: Money, amountPaid: Money): Money {
  return subtractMoney(total, amountPaid);
}
