import type { SubscriptionStatus } from '@ghmt/shared';
import { addDays } from './period';

/** Transitions autorisées (docs/05 A6). Seul ce graphe modifie `subscriptions.status`. */
const TRANSITIONS: Readonly<Record<SubscriptionStatus, readonly SubscriptionStatus[]>> = {
  trial: ['active', 'expired'],
  active: ['active', 'past_due', 'cancelled'],
  past_due: ['active', 'grace'],
  grace: ['active', 'suspended'],
  suspended: ['active', 'expired'],
  cancelled: ['active', 'expired'],
  expired: ['active'],
};

export function canTransition(from: SubscriptionStatus, to: SubscriptionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Délais en jours, mesurés depuis la fin de période (paramètres plateforme, docs/05 A6). */
export const LIFECYCLE_DAYS = {
  pastDueToGrace: 7,
  graceToSuspended: 15,
  suspendedToExpired: 75,
  /** Rétention après résiliation effective. */
  cancelledToExpired: 90,
} as const;

export interface LifecycleSnapshot {
  readonly status: SubscriptionStatus;
  readonly currentPeriodEnd: Date;
  readonly trialEndsAt: Date | null;
  readonly statusChangedAt: Date;
  readonly cancelAtPeriodEnd: boolean;
}

/**
 * Prochaine transition automatique à l'instant `now`, ou `null`. Les seuils sont ancrés sur la fin de période
 * (et non sur la date de la dernière exécution du job) : un retard du job ne décale jamais les échéances.
 */
export function nextLifecycleStatus(s: LifecycleSnapshot, now: Date): SubscriptionStatus | null {
  const at = now.getTime();
  const end = s.currentPeriodEnd;
  switch (s.status) {
    case 'trial':
      return s.trialEndsAt && at >= s.trialEndsAt.getTime() ? 'expired' : null;
    case 'active':
      if (at < end.getTime()) return null;
      return s.cancelAtPeriodEnd ? 'cancelled' : 'past_due';
    case 'past_due':
      return at >= addDays(end, LIFECYCLE_DAYS.pastDueToGrace).getTime() ? 'grace' : null;
    case 'grace':
      return at >= addDays(end, LIFECYCLE_DAYS.graceToSuspended).getTime() ? 'suspended' : null;
    case 'suspended':
      return at >= addDays(end, LIFECYCLE_DAYS.suspendedToExpired).getTime() ? 'expired' : null;
    case 'cancelled':
      return at >= addDays(s.statusChangedAt, LIFECYCLE_DAYS.cancelledToExpired).getTime() ? 'expired' : null;
    case 'expired':
      return null;
  }
}
