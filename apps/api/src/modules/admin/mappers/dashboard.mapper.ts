import { APPOINTMENT_STATUSES, PAYMENT_METHODS, type AppointmentStatus, type PaymentMethod, type PaymentMethodTotals } from '@ghmt/shared';
import { formatMoney, sumMoney, zeroMoney, type Money } from '../../../common/money/money';

/** Les 8 statuts sont toujours présents (zéros compris). */
export function toStatusCounts(counted: ReadonlyMap<AppointmentStatus, number>): Record<AppointmentStatus, number> {
  return Object.fromEntries(APPOINTMENT_STATUSES.map((status) => [status, counted.get(status) ?? 0])) as Record<AppointmentStatus, number>;
}

export function toMethodTotals(sums: ReadonlyMap<PaymentMethod, Money>): { readonly total: string; readonly byMethod: PaymentMethodTotals } {
  const byMethod = Object.fromEntries(PAYMENT_METHODS.map((method) => [method, formatMoney(sums.get(method) ?? zeroMoney())])) as PaymentMethodTotals;
  return { total: formatMoney(sumMoney([...sums.values()])), byMethod };
}
