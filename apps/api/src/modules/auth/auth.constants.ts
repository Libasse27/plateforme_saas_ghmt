/** Constantes du module auth (durées en millisecondes sauf mention contraire). */
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Session : durée absolue 30 jours. */
export const SESSION_TTL_MS = 30 * DAY_MS;
/** Refresh token : 7 jours glissants, sans dépasser la session. */
export const REFRESH_TOKEN_TTL_MS = 7 * DAY_MS;
/** Rejeu réseau toléré d'un refresh token déjà consommé. */
export const REFRESH_GRACE_WINDOW_MS = 10_000;

export const MFA_CHALLENGE_TTL_MS = 5 * MINUTE_MS;
export const MFA_CHALLENGE_MAX_ATTEMPTS = 5;
export const TOTP_ISSUER = 'GHMT';
export const TOTP_KIND = 'totp';
/** Tolérance TOTP : ±1 pas de 30 s. */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_EPOCH_TOLERANCE_SECONDS = TOTP_PERIOD_SECONDS;

export const LOCKOUT_THRESHOLD = 5;
/** Durées de verrouillage successives (minutes), la dernière faisant plafond. */
export const LOCKOUT_MINUTES: readonly number[] = [1, 5, 15, 60];
export const MINUTE = MINUTE_MS;

export const SIGNUP_THROTTLE = { default: { limit: 5, ttl: 60 * MINUTE_MS } } as const;
export const LOGIN_THROTTLE = { default: { limit: 20, ttl: 15 * MINUTE_MS } } as const;
export const MFA_VERIFY_THROTTLE = { default: { limit: 20, ttl: 15 * MINUTE_MS } } as const;
export const MFA_ACTIVATE_THROTTLE = { default: { limit: 10, ttl: 15 * MINUTE_MS } } as const;
export const INVITATION_THROTTLE = { default: { limit: 20, ttl: 15 * MINUTE_MS } } as const;
export const PASSWORD_CHANGE_THROTTLE = { default: { limit: 10, ttl: 15 * MINUTE_MS } } as const;
export const LOGOUT_THROTTLE = { default: { limit: 60, ttl: MINUTE_MS } } as const;
