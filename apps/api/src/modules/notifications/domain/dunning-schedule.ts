import type { NotificationTypeCode } from '@ghmt/shared';

const DAY_MS = 86_400_000;
const DIRECTORS_FROM_OFFSET_DAYS = 7;

export interface DunningStep {
  readonly offsetDays: number;
  readonly index: number;
}

/**
 * Dernière étape atteinte du calendrier (décalages en jours relatifs à `dueAt`). Seule celle-ci donne lieu à une
 * relance : les étapes manquées ne sont pas rattrapées en rafale (docs/10 D15).
 */
export function latestReachedStep(offsets: readonly number[], dueAt: Date, now: Date): DunningStep | null {
  let reached: DunningStep | null = null;
  offsets.forEach((offsetDays, index) => {
    if (now.getTime() >= dueAt.getTime() + offsetDays * DAY_MS) reached = { offsetDays, index };
  });
  return reached;
}

/** Type de relance : 1re étape = facture émise, dernière = avis de suspension, sinon avant/après échéance. */
export function dunningTypeFor(index: number, offsets: readonly number[]): NotificationTypeCode {
  if (index === 0) return 'subscription.invoice_issued';
  if (index === offsets.length - 1) return 'subscription.suspension_notice';
  return (offsets[index] ?? 0) <= 0 ? 'subscription.payment_reminder' : 'subscription.payment_overdue';
}

/** À partir de J+7, les titulaires du rôle système `director` reçoivent aussi la relance. */
export function includesDirectors(offsetDays: number): boolean {
  return offsetDays >= DIRECTORS_FROM_OFFSET_DAYS;
}

/** Jours entiers de retard par rapport à l'échéance (0 avant et le jour de l'échéance). */
export function daysLate(dueAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - dueAt.getTime()) / DAY_MS));
}
