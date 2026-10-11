const DEFAULT_API_URL = 'http://localhost:3000/api/v1';

type Env = Readonly<Record<string, string | undefined>>;

/** URL de l'API, lue côté serveur uniquement (API_URL). */
export function getApiUrl(env: Env = process.env): string {
  const raw = env.API_URL?.trim();
  return (raw && raw.length > 0 ? raw : DEFAULT_API_URL).replace(/\/+$/, '');
}

/** Cookies Secure : SESSION_COOKIE_SECURE explicite, sinon actif en production. */
export function isSecureCookies(env: Env = process.env): boolean {
  const flag = env.SESSION_COOKIE_SECURE?.trim().toLowerCase();
  if (flag === 'true' || flag === '1') return true;
  if (flag === 'false' || flag === '0') return false;
  return env.NODE_ENV === 'production';
}

const MAX_TRUSTED_PROXY_HOPS = 5;
/** Longueur minimale du secret de bordure (docs/11 §8). */
export const EDGE_PROXY_SECRET_MIN_LENGTH = 32;

function isProduction(env: Env): boolean {
  return env.NODE_ENV === 'production';
}

/**
 * Nombre de proxys de confiance devant le BFF (docs/11 D11) : l'IP cliente est l'entrée `length - n` de X-Forwarded-For.
 * Entier de 0 à 5. Absent hors production : 1 (compatibilité). En production : obligatoire, 1 ou plus.
 */
export function getTrustedProxyHops(env: Env = process.env): number {
  const raw = env.TRUSTED_PROXY_HOPS?.trim();
  if (!raw) {
    if (isProduction(env)) throw new Error('Configuration invalide : TRUSTED_PROXY_HOPS est obligatoire en production (1 ou plus).');
    return 1;
  }
  const hops = /^\d$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(hops) || hops > MAX_TRUSTED_PROXY_HOPS) {
    throw new Error(`Configuration invalide : TRUSTED_PROXY_HOPS doit être un entier de 0 à ${MAX_TRUSTED_PROXY_HOPS}.`);
  }
  if (hops === 0 && isProduction(env)) {
    throw new Error('Configuration invalide : TRUSTED_PROXY_HOPS doit valoir 1 ou plus en production.');
  }
  return hops;
}

/**
 * Secret partagé avec le proxy de bordure (en-tête `X-Ghmt-Edge-Auth`, docs/11 D11) : 32 caractères ou plus,
 * obligatoire en production. Absent hors production : `undefined` (accès direct autorisé en développement).
 * La valeur n'apparaît jamais dans les messages d'erreur.
 */
export function getEdgeProxySecret(env: Env = process.env): string | undefined {
  const secret = env.EDGE_PROXY_SECRET?.trim();
  if (!secret) {
    if (isProduction(env)) throw new Error('Configuration invalide : EDGE_PROXY_SECRET est obligatoire en production.');
    return undefined;
  }
  if (secret.length < EDGE_PROXY_SECRET_MIN_LENGTH) {
    throw new Error(`Configuration invalide : EDGE_PROXY_SECRET doit contenir au moins ${EDGE_PROXY_SECRET_MIN_LENGTH} caractères.`);
  }
  return secret;
}
