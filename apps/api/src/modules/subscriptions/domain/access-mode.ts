import type { SubscriptionAccessMode, SubscriptionStatus } from '@ghmt/shared';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Mode d'accès : `restricted` = grâce, `continuity` = suspendu, résilié ou expiré (lecture seule sauf continuité des soins). */
export function accessModeOf(status: SubscriptionStatus): SubscriptionAccessMode {
  if (status === 'grace') return 'restricted';
  if (status === 'suspended' || status === 'cancelled' || status === 'expired') return 'continuity';
  return 'normal';
}

/** Jours restants d'essai (arrondis au jour supérieur, jamais négatifs) ; null hors essai. */
export function trialDaysLeft(status: SubscriptionStatus, trialEndsAt: Date | null, now: Date): number | null {
  if (status !== 'trial' || !trialEndsAt) return null;
  return Math.max(0, Math.ceil((trialEndsAt.getTime() - now.getTime()) / MS_PER_DAY));
}
