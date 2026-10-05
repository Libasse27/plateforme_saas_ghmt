const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** Realm plateforme : sessions plus courtes que celles des tenants (accès à privilèges élevés). */
export const PLATFORM_SESSION_TTL_MS = 12 * HOUR_MS;
export const PLATFORM_REFRESH_TTL_MS = 2 * HOUR_MS;
export const PLATFORM_MFA_CHALLENGE_TTL_MS = 5 * MINUTE_MS;
export const PLATFORM_MFA_MAX_ATTEMPTS = 5;
/** Nom d'émetteur dans le chiffrement du secret TOTP (AAD) : sépare les secrets plateforme de ceux des tenants. */
export const PLATFORM_CRYPTO_SCOPE = 'platform';

export const PLATFORM_LOGIN_THROTTLE = { default: { limit: 10, ttl: 15 * MINUTE_MS } } as const;
export const PLATFORM_MFA_THROTTLE = { default: { limit: 10, ttl: 15 * MINUTE_MS } } as const;
export const PLATFORM_REFRESH_THROTTLE = { default: { limit: 30, ttl: MINUTE_MS } } as const;
