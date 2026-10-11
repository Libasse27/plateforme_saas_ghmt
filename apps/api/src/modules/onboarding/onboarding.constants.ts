import { PENDING_SIGNUP_EXPIRY_DAYS, SIGNUP_VERIFICATION_TTL_HOURS } from '@ghmt/shared';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Validité du jeton de vérification (24 h). */
export const SIGNUP_VERIFICATION_TTL_MS = SIGNUP_VERIFICATION_TTL_HOURS * HOUR_MS;
/** Une inscription non confirmée au bout de ce délai (7 jours) expire. */
export const PENDING_SIGNUP_EXPIRY_MS = PENDING_SIGNUP_EXPIRY_DAYS * DAY_MS;
/** Les jetons de vérification expirés depuis plus de ce délai sont purgés. */
export const SIGNUP_VERIFICATION_PURGE_AFTER_MS = DAY_MS;
/** Plafond de lignes supprimées par établissement et par passe. */
export const SIGNUP_VERIFICATION_PURGE_BATCH = 5_000;
/** Passe de rattrapage après le démarrage de l'application. */
export const STARTUP_PASS_DELAY_MS = 60_000;

/** Limites de débit (docs/11 §6.2) : par IP, et pour le renvoi par identifiant `signup_resend`. */
export const VERIFY_SIGNUP_THROTTLE = { default: { limit: 20, ttl: 15 * MINUTE_MS } } as const;
export const RESEND_SIGNUP_THROTTLE = {
  default: { limit: 5, ttl: HOUR_MS },
  account: { limit: 3, ttl: HOUR_MS },
} as const;

/** E-mails de vérification par adresse de destination (tous établissements) : 5 par heure. */
export const SIGNUP_MAIL_PER_ADDRESS_LIMIT = 5;
export const SIGNUP_MAIL_PER_ADDRESS_WINDOW_MS = HOUR_MS;
/** Anonymisation du fondateur d'une inscription expirée : 30 jours après l'expiration. */
export const EXPIRED_FOUNDER_ANONYMIZE_AFTER_MS = 30 * DAY_MS;
