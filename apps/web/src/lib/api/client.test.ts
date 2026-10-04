import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildUrl, request, requestWithSession, type TokenStore } from './client';
import { ApiError } from './errors';
import { jsonResponse, okEnvelope, problem } from './test-helpers';
import { resetRefreshCache } from './refresh';

const BASE = 'http://api.test/api/v1';
const PAIR = { accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 900 };

function memoryStore(initial: { accessToken?: string; refreshToken?: string }, persist = true) {
  let tokens = { ...initial };
  const write = vi.fn(async (pair: { accessToken: string; refreshToken: string }) => {
    tokens = { accessToken: pair.accessToken, refreshToken: pair.refreshToken };
  });
  const clear = vi.fn(async () => {
    tokens = {};
  });
  const store: TokenStore = persist ? { read: async () => tokens, write, clear } : { read: async () => tokens };
  return { store, write, clear, current: () => tokens };
}

afterEach(() => {
  resetRefreshCache();
  vi.restoreAllMocks();
});

describe('buildUrl', () => {
  it('assemble base, chemin et paramètres en ignorant les valeurs vides', () => {
    const url = buildUrl(`${BASE}/`, '/patients', { q: 'diallo', limit: 20, cursor: undefined, x: null, flag: false });
    expect(url).toBe(`${BASE}/patients?q=diallo&limit=20&flag=false`);
  });

  it('encode les caractères spéciaux', () => {
    expect(buildUrl(BASE, 'patients', { q: 'a&b=é +' })).toBe(`${BASE}/patients?q=a%26b%3D%C3%A9+%2B`);
  });
});

describe('request', () => {
  it('envoie le jeton Bearer et un corps JSON', async () => {
    const fetchImpl = vi.fn(async () => okEnvelope({ id: 'p1' }, {}, 201));
    const result = await request({ baseUrl: BASE, fetchImpl }, '/patients', {
      method: 'POST',
      body: { lastName: 'Diallo' },
      accessToken: 'tok',
    });
    expect(result.data).toEqual({ id: 'p1' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/patients`);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ lastName: 'Diallo' }));
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok');
    expect(headers['content-type']).toBe('application/json');
    expect(headers.accept).toBe('application/json');
    expect(init.cache).toBe('no-store');
  });

  it('n\'ajoute ni Authorization ni corps sur un GET anonyme', async () => {
    const fetchImpl = vi.fn(async () => okEnvelope(null));
    await request({ baseUrl: BASE, fetchImpl }, '/org/sites');
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(init.body).toBeUndefined();
    expect(init.method).toBe('GET');
  });

  it('convertit une panne réseau en ApiError network_error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const error = (await request({ baseUrl: BASE, fetchImpl }, '/x').catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('network_error');
    expect(error.status).toBe(0);
  });

  it('convertit un dépassement de délai en ApiError timeout', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('timeout', 'TimeoutError');
    });
    const error = (await request({ baseUrl: BASE, fetchImpl }, '/x').catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('timeout');
  });
});

describe('requestWithSession', () => {
  it('appelle l\'API avec le jeton d\'accès courant sans rafraîchir', async () => {
    const { store, write } = memoryStore({ accessToken: 'a', refreshToken: 'r' });
    const fetchImpl = vi.fn(async () => okEnvelope({ ok: true }));
    const result = await requestWithSession({ baseUrl: BASE, fetchImpl }, store, '/auth/me');
    expect(result.data).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
  });

  it('rafraîchit une seule fois sur 401 puis rejoue la requête avec le nouveau jeton', async () => {
    const { store, write, current } = memoryStore({ accessToken: 'old', refreshToken: 'r' });
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/auth/refresh')) {
        expect(JSON.parse(init.body as string)).toEqual({ refreshToken: 'r' });
        return okEnvelope(PAIR);
      }
      const auth = (init.headers as Record<string, string>).authorization;
      return auth === 'Bearer new-access' ? okEnvelope({ id: 1 }) : problem(401, 'unauthenticated');
    });
    const result = await requestWithSession({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch }, store, '/patients');
    expect(result.data).toEqual({ id: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(write).toHaveBeenCalledWith(PAIR);
    expect(current().accessToken).toBe('new-access');
  });

  it('ne boucle pas : un second 401 après rafraîchissement est propagé', async () => {
    const { store } = memoryStore({ accessToken: 'old', refreshToken: 'r' });
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/auth/refresh') ? okEnvelope(PAIR) : problem(401, 'unauthenticated'),
    );
    const error = (await requestWithSession({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch }, store, '/patients').catch(
      (e: unknown) => e,
    )) as ApiError;
    expect(error.status).toBe(401);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('efface la session si le rafraîchissement est refusé', async () => {
    const { store, clear } = memoryStore({ accessToken: 'old', refreshToken: 'r' });
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/auth/refresh') ? problem(401, 'invalid_refresh_token') : problem(401, 'unauthenticated'),
    );
    const error = (await requestWithSession({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch }, store, '/patients').catch(
      (e: unknown) => e,
    )) as ApiError;
    expect(error.status).toBe(401);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('conserve la session si le rafraîchissement échoue pour une raison transitoire', async () => {
    const { store, clear } = memoryStore({ accessToken: 'old', refreshToken: 'r' });
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/auth/refresh') ? problem(503, 'unavailable') : problem(401, 'unauthenticated'),
    );
    const error = (await requestWithSession({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch }, store, '/patients').catch(
      (e: unknown) => e,
    )) as ApiError;
    expect(error.status).toBe(503);
    expect(clear).not.toHaveBeenCalled();
  });

  it('rafraîchit d\'abord quand le jeton d\'accès est absent (expiré côté cookie)', async () => {
    const { store, write } = memoryStore({ refreshToken: 'r' });
    const fetchImpl = vi.fn(async (url: string) => (url.endsWith('/auth/refresh') ? okEnvelope(PAIR) : okEnvelope({ id: 2 })));
    const result = await requestWithSession({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch }, store, '/patients');
    expect(result.data).toEqual({ id: 2 });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('ne rafraîchit pas quand le magasin est en lecture seule (rendu serveur)', async () => {
    const { store } = memoryStore({ accessToken: 'old', refreshToken: 'r' }, false);
    const fetchImpl = vi.fn(async () => problem(401, 'unauthenticated'));
    const error = (await requestWithSession({ baseUrl: BASE, fetchImpl }, store, '/patients').catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(401);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuse sans aucun jeton', async () => {
    const { store } = memoryStore({});
    const fetchImpl = vi.fn();
    const error = (await requestWithSession({ baseUrl: BASE, fetchImpl }, store, '/patients').catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('propage les erreurs non 401 sans rafraîchir', async () => {
    const { store } = memoryStore({ accessToken: 'a', refreshToken: 'r' });
    const fetchImpl = vi.fn(async () => problem(403, 'permission_denied'));
    const error = (await requestWithSession({ baseUrl: BASE, fetchImpl }, store, '/patients').catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(403);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('mutualise les rafraîchissements concurrents (rotation du refresh token)', async () => {
    const a = memoryStore({ refreshToken: 'same' });
    const b = memoryStore({ refreshToken: 'same' });
    let refreshCalls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/auth/refresh')) {
        refreshCalls += 1;
        return okEnvelope(PAIR);
      }
      return okEnvelope({});
    });
    const deps = { baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch };
    await Promise.all([requestWithSession(deps, a.store, '/x'), requestWithSession(deps, b.store, '/y')]);
    expect(refreshCalls).toBe(1);
    expect(a.write).toHaveBeenCalledWith(PAIR);
    expect(b.write).toHaveBeenCalledWith(PAIR);
  });
});

describe('refreshSession', () => {
  it('rejette une réponse de rafraîchissement sans jetons', async () => {
    const { store } = memoryStore({ refreshToken: 'r' });
    const fetchImpl = vi.fn(async () => okEnvelope({ nope: true }));
    const error = (await requestWithSession({ baseUrl: BASE, fetchImpl }, store, '/x').catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(401);
  });

  it('ne met pas un échec en cache : un nouvel essai refait l\'appel', async () => {
    const { store } = memoryStore({ refreshToken: 'r2' });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(problem(503, 'unavailable'))
      .mockResolvedValueOnce(okEnvelope(PAIR))
      .mockResolvedValueOnce(okEnvelope({ ok: 1 }));
    const deps = { baseUrl: BASE, fetchImpl };
    await requestWithSession(deps, store, '/x').catch(() => undefined);
    const result = await requestWithSession(deps, store, '/x');
    expect(result.data).toEqual({ ok: 1 });
  });
});

describe('réponses non JSON', () => {
  it('gère jsonResponse brute', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { success: true, data: 1, error: null, meta: {} }));
    expect((await request({ baseUrl: BASE, fetchImpl }, '/n')).data).toBe(1);
  });
});
