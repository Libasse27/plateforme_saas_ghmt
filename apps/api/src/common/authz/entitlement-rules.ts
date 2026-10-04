import { DomainError } from '../errors/domain-error';

/** Sources de rendez-vous : le guichet (accueil, téléphone) n'est jamais bloqué par le quota (docs/09 §A2). */
const ONLINE_SOURCES: ReadonlySet<string> = new Set(['web', 'mobile_app']);

/** Tolérance de la limite souple des rendez-vous : 120 % (docs/05 A7), en entiers pour éviter les flottants. */
const SOFT_TOLERANCE_NUMERATOR = 12n;
const SOFT_TOLERANCE_DENOMINATOR = 10n;

export interface LimitViolation {
  readonly limit: number;
  readonly current: number;
}

/** Limite dure : ajouter un élément à `current` éléments dépasserait `limit` dès que `current >= limit`. `null` = illimité. */
export function hardLimitViolation(limit: number | null, current: number): LimitViolation | null {
  if (limit === null) return null;
  return current >= limit ? { limit, current } : null;
}

/**
 * Limite souple des rendez-vous du mois : au-delà de 120 % de la limite, seules les sources en ligne
 * (`web`, `mobile_app`) sont refusées. Le 120 % est inclus : `limite × 1,2` rendez-vous restent acceptés.
 */
export function appointmentQuotaDecision(input: { limit: number | null; current: number; source: string }): 'allowed' | 'refused' {
  if (input.limit === null || !ONLINE_SOURCES.has(input.source)) return 'allowed';
  const afterCreation = BigInt(input.current + 1) * SOFT_TOLERANCE_DENOMINATOR;
  const ceiling = BigInt(input.limit) * SOFT_TOLERANCE_NUMERATOR;
  return afterCreation > ceiling ? 'refused' : 'allowed';
}

export type LimitMetric = 'users' | 'sites' | 'appointmentsMonthly';

const METRIC_LABEL: Record<LimitMetric, string> = {
  users: 'd’utilisateurs',
  sites: 'de sites',
  appointmentsMonthly: 'de rendez-vous en ligne ce mois',
};

/** 403 `plan_limit_reached` : le détail `{ limit, current }` permet à l'interface de proposer une montée en gamme. */
export function planLimitReached(metric: LimitMetric, violation: LimitViolation): DomainError {
  return new DomainError(
    'plan_limit_reached',
    403,
    'Forbidden',
    `La limite ${METRIC_LABEL[metric]} de votre offre est atteinte.`,
    { details: { metric, limit: violation.limit, current: violation.current } },
  );
}

/** Mois civil UTC contenant `date` : `[start, end[`. Sert au quota de rendez-vous et à l'usage affiché. */
export function utcMonthBounds(date: Date): { readonly start: Date; readonly end: Date } {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return { start, end };
}
