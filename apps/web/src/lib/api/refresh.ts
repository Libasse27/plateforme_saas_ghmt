import { forwardHeaders, type ClientInfo } from './client-info';
import { readEnvelope } from './envelope';
import { ApiError } from './errors';
import type { TokenPair } from './types';

export interface RefreshDeps {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly clientInfo?: ClientInfo | undefined;
  /** Chemin du rafraîchissement : `/auth/refresh` (établissement) ou `/platform/auth/refresh` (plateforme). */
  readonly refreshPath?: string | undefined;
}

export const TENANT_REFRESH_PATH = '/auth/refresh';
export const PLATFORM_REFRESH_PATH = '/platform/auth/refresh';

/**
 * Le refresh token est rotatif avec détection de réutilisation (docs/04) : deux rafraîchissements
 * concurrents avec le même jeton révoqueraient la session. On mutualise donc les appels
 * (navigation parallèle, prefetch) et on rejoue le résultat pendant une courte fenêtre.
 */
const REPLAY_WINDOW_MS = 10_000;
const REFRESH_TIMEOUT_MS = 10_000;

interface CacheEntry {
  readonly promise: Promise<TokenPair>;
  settledAt: number | null;
}

const cache = new Map<string, CacheEntry>();

export function resetRefreshCache(): void {
  cache.clear();
}

function prune(now: number): void {
  for (const [key, entry] of cache) {
    if (entry.settledAt !== null && now - entry.settledAt > REPLAY_WINDOW_MS) cache.delete(key);
  }
}

export function parseTokenPair(raw: unknown): TokenPair | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { accessToken, refreshToken, expiresIn } = raw as Record<string, unknown>;
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') return null;
  if (accessToken.length === 0 || refreshToken.length === 0) return null;
  return typeof expiresIn === 'number' && expiresIn > 0
    ? { accessToken, refreshToken, expiresIn }
    : { accessToken, refreshToken };
}

async function callRefresh(deps: RefreshDeps, refreshToken: string): Promise<TokenPair> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${deps.baseUrl.replace(/\/+$/, '')}${deps.refreshPath ?? TENANT_REFRESH_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...forwardHeaders(deps.clientInfo) },
      body: JSON.stringify({ refreshToken }),
      cache: 'no-store',
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
  } catch {
    throw ApiError.network();
  }
  const { data } = await readEnvelope(response);
  const pair = parseTokenPair(data);
  if (!pair) throw ApiError.unauthenticated();
  return pair;
}

export function refreshSession(deps: RefreshDeps, refreshToken: string): Promise<TokenPair> {
  const now = Date.now();
  prune(now);
  const existing = cache.get(refreshToken);
  if (existing) return existing.promise;

  const promise = callRefresh(deps, refreshToken);
  const entry: CacheEntry = { promise, settledAt: null };
  cache.set(refreshToken, entry);
  promise.then(
    () => {
      entry.settledAt = Date.now();
    },
    () => {
      cache.delete(refreshToken);
    },
  );
  return promise;
}
