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
