import { forwardHeaders, type ClientInfo } from './client-info';
import { readEnvelope } from './envelope';
import { ApiError, isApiError } from './errors';
import { refreshSession } from './refresh';
import type { ApiSuccess, TokenPair } from './types';

const REQUEST_TIMEOUT_MS = 15_000;

export type QueryValue = string | number | boolean | undefined | null;

export interface ClientDeps {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
  /** C9 : IP et User-Agent du client final, transmis à l'API. */
  readonly clientInfo?: ClientInfo | undefined;
  /** Chemin de rafraîchissement du realm (défaut : établissement). */
  readonly refreshPath?: string | undefined;
}

export interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly body?: unknown;
  readonly accessToken?: string | undefined;
  /** En-têtes additionnels (ex. If-Match). */
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

export interface StoredTokens {
  readonly accessToken?: string | undefined;
  readonly refreshToken?: string | undefined;
}

/** `write` absent = magasin en lecture seule (rendu serveur) : pas de rafraîchissement possible. */
export interface TokenStore {
  read(): Promise<StoredTokens>;
  write?(pair: TokenPair): Promise<void>;
  clear?(): Promise<void>;
}

export function buildUrl(baseUrl: string, path: string, query?: Readonly<Record<string, QueryValue>>): string {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${base}${suffix}?${qs}` : `${base}${suffix}`;
}

/** Un appel HTTP unique vers l'API, sans gestion de session. */
export async function request<T = unknown>(deps: ClientDeps, path: string, options: RequestOptions = {}): Promise<ApiSuccess<T>> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const headers: Record<string, string> = { accept: 'application/json', ...forwardHeaders(deps.clientInfo), ...options.headers };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.accessToken) headers.authorization = `Bearer ${options.accessToken}`;

  let response: Response;
  try {
    response = await fetchImpl(buildUrl(deps.baseUrl, path, options.query), {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw error instanceof DOMException && error.name === 'TimeoutError' ? ApiError.timeout() : ApiError.network();
  }
  return readEnvelope<T>(response);
}

/** Le refresh token est invalide, expiré ou réutilisé : la session est perdue. */
function isSessionLost(error: unknown): boolean {
  return isApiError(error) && (error.status === 401 || error.status === 403);
}

async function refreshAndStore(deps: ClientDeps, store: TokenStore, refreshToken: string): Promise<TokenPair> {
  try {
    const pair = await refreshSession(deps, refreshToken);
    await store.write?.(pair);
    return pair;
  } catch (error) {
    if (isSessionLost(error)) await store.clear?.();
    throw error;
  }
}

/**
 * Appel authentifié : rafraîchit la session au plus une fois (absence de jeton d'accès ou 401),
 * puis rejoue la requête. Toute nouvelle 401 est propagée.
 */
export async function requestWithSession<T = unknown>(
  deps: ClientDeps,
  store: TokenStore,
  path: string,
  options: Omit<RequestOptions, 'accessToken'> = {},
): Promise<ApiSuccess<T>> {
  const tokens = await store.read();
  const canRefresh = Boolean(store.write) && Boolean(tokens.refreshToken);
  let accessToken = tokens.accessToken;
  let refreshed = false;

  if (!accessToken) {
    if (!canRefresh || !tokens.refreshToken) throw ApiError.unauthenticated();
    accessToken = (await refreshAndStore(deps, store, tokens.refreshToken)).accessToken;
    refreshed = true;
  }

  try {
    return await request<T>(deps, path, { ...options, accessToken });
  } catch (error) {
    const unauthorized = isApiError(error) && error.status === 401;
    if (!unauthorized || refreshed || !canRefresh || !tokens.refreshToken) throw error;
    const pair = await refreshAndStore(deps, store, tokens.refreshToken).catch((refreshError: unknown) => {
      throw isSessionLost(refreshError) ? error : refreshError;
    });
    return request<T>(deps, path, { ...options, accessToken: pair.accessToken });
  }
}
