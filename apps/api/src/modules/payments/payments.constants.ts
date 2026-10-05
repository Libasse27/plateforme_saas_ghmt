const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** `fetch` utilisé pour joindre les agrégateurs (remplaçable dans les tests). */
export const PAYMENTS_FETCH = Symbol('PAYMENTS_FETCH');

/** Une tentative en attente depuis plus de 10 minutes est interrogée directement auprès de l'agrégateur… */
export const PENDING_RETRY_AFTER_MS = 10 * MINUTE_MS;
/** …pendant 24 h (abonnement SaaS), après quoi elle expire (payment.failed, motif `expired`). */
export const PENDING_EXPIRY_MS = 24 * HOUR_MS;
/** Une tentative de facture patient expire plus vite : le patient est au guichet (docs/09 §R4). */
export const PATIENT_INVOICE_EXPIRY_MS = 30 * MINUTE_MS;
/** Intervalle minimal entre deux vérifications d'une même tentative (le webhook compte comme une vérification). */
export const RECHECK_MIN_INTERVAL_MS = 5 * MINUTE_MS;
/** Un règlement non notifié aux abonnés depuis plus d'une minute est republié par le job. */
export const REPUBLISH_AFTER_MS = MINUTE_MS;
/** Nombre maximal de tentatives traitées par exécution du job. */
export const RETRY_BATCH_SIZE = 200;

export const WEBHOOK_THROTTLE = { default: { limit: 120, ttl: MINUTE_MS } } as const;
/** Corps de webhook : 1 Mo au plus (aligné sur la limite JSON de l'application). */
export const WEBHOOK_BODY_LIMIT_BYTES = 1024 * 1024;

export const FAILURE_REASONS = {
  declined: 'declined_by_provider',
  amountMismatch: 'amount_mismatch',
  expired: 'expired',
  providerUnavailable: 'provider_unavailable',
  refused: 'refused_by_provider',
  abandoned: 'abandoned',
} as const;
