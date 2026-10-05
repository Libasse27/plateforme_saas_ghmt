const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Relais de l'outbox : 10 essais, backoff 1 min × 2^n (docs/10 §5.8). */
export const OUTBOX_MAX_ATTEMPTS = 10;
export const OUTBOX_BACKOFF_BASE_MS = MINUTE_MS;
/** Bail posé par le dispatcher sur une notification réservée (`locked_until`). */
export const LEASE_MS = 2 * MINUTE_MS;
/** Garde-fou : nombre maximal de lots traités par établissement et par passe. */
export const MAX_BATCHES_PER_TICK = 20;
/** Nombre maximal d'établissements découverts par passe (`platform.notification_due_tenants`). */
export const DUE_TENANTS_LIMIT = 500;

export const INAPP_TTL_MS = 30 * DAY_MS;
export const INAPP_UNREAD_CAP = 999;
export const INAPP_LINK_SUBSCRIPTION = '/abonnement';

/** Au-delà de ces délais, plus de lecture ni de routage de STOP. */
export const STOP_ROUTING_WINDOW_MS = 180 * DAY_MS;
export const OUTBOX_RETENTION_MS = 30 * DAY_MS;

/** Balayeur de rattrapage (docs/10 §5.8). */
export const SWEEPER_HORIZON_MS = 26 * HOUR_MS;
export const SWEEPER_MIN_LEAD_MS = 5 * MINUTE_MS;

/** Fenêtre de retry d'un SMS transactionnel (création + 2 h), repoussée quand l'envoi est reporté en fin de plage silencieuse. */
export const SMS_RETRY_WINDOW_MS = 2 * HOUR_MS;

/** Fraîcheur des rapports : H-2 est inutile s'il ne peut partir qu'à moins d'1 h du rendez-vous après une plage silencieuse. */
export const H2_TOO_LATE_MS = HOUR_MS;

export const QUOTA_THRESHOLDS: readonly number[] = [80, 100];

export const WEBHOOK_THROTTLE = { default: { limit: 60, ttl: MINUTE_MS } } as const;
export const WEBHOOK_BODY_LIMIT_BYTES = 64 * 1024;
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export const DELIVERIES_DEFAULT_RANGE_MS = 7 * DAY_MS;
export const DELIVERIES_MAX_RANGE_MS = 31 * DAY_MS;
export const CONSENT_HISTORY_LIMIT = 50;

export const SAAS_DUNNING_STARTUP_DELAY_MS = 30 * SECOND_MS;
export const SYSTEM_ACTOR = { actorType: 'system' } as const;
