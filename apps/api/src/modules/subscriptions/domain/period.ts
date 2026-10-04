import type { BillingPeriod } from '@ghmt/shared';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function addMonths(date: Date, months: number): Date {
  const totalMonths = date.getUTCFullYear() * 12 + date.getUTCMonth() + months;
  const year = Math.floor(totalMonths / 12);
  const monthIndex = totalMonths % 12;
  const day = Math.min(date.getUTCDate(), daysInMonth(year, monthIndex));
  return new Date(
    Date.UTC(year, monthIndex, day, date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()),
  );
}

/** Fin d'une période de facturation débutant à `start` (mois ou année civils UTC, jour ramené au dernier jour valide). */
export function addBillingPeriod(start: Date, period: BillingPeriod): Date {
  return addMonths(start, period === 'monthly' ? 1 : 12);
}
