/** Jeton du plafond de lignes d'un export CSV (surchargeable dans les tests ; défaut `AUDIT_EXPORT_MAX_ROWS`). */
export const AUDIT_EXPORT_LIMIT = Symbol('AUDIT_EXPORT_LIMIT');

const MINUTE_MS = 60_000;

/** Export du journal : 5 requêtes par 10 minutes et par IP (docs/10 §6). */
export const AUDIT_EXPORT_THROTTLE = { default: { limit: 5, ttl: 10 * MINUTE_MS } } as const;
/** Vérification d'intégrité : 3 requêtes par minute et par IP (opération coûteuse). */
export const AUDIT_VERIFY_THROTTLE = { default: { limit: 3, ttl: MINUTE_MS } } as const;

/** Taille des lots de relecture de la chaîne d'audit. */
export const AUDIT_VERIFY_BATCH_SIZE = 1000;
