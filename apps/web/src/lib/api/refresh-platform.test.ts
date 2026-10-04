import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestWithSession } from './client';
import { okEnvelope, problem } from './test-helpers';
import { PLATFORM_REFRESH_PATH, refreshSession, resetRefreshCache } from './refresh';

const BASE = 'http://api.test/api/v1';

afterEach(() => {
  resetRefreshCache();
});

describe('rafraîchissement du realm plateforme', () => {
  it('appelle /platform/auth/refresh quand le chemin est fourni', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => okEnvelope({ accessToken: 'a', refreshToken: 'p.b', expiresIn: 900 }));
    const pair = await refreshSession({ baseUrl: BASE, fetchImpl: fetchMock, refreshPath: PLATFORM_REFRESH_PATH }, 'p.old-refresh-token');
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE}/platform/auth/refresh`);
    expect(pair.refreshToken).toBe('p.b');
  });

  it('utilise le chemin établissement par défaut', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => okEnvelope({ accessToken: 'a', refreshToken: 'b' }));
    await refreshSession({ baseUrl: BASE, fetchImpl: fetchMock }, 'old-tenant-refresh');
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE}/auth/refresh`);
  });

  it('requestWithSession rafraîchit via le chemin plateforme sur 401 puis rejoue', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/platform/dashboard') && calls.length === 1) return problem(401, 'unauthenticated');
      if (url.endsWith('/platform/auth/refresh')) return okEnvelope({ accessToken: 'n', refreshToken: 'p.n' });
      return okEnvelope({ ok: true });
    });
    let tokens = { accessToken: 'old', refreshToken: 'p.refresh-token-123' };
    const write = vi.fn(async (pair: { accessToken: string; refreshToken: string }) => {
      tokens = pair;
    });
    const result = await requestWithSession<{ ok: boolean }>(
      { baseUrl: BASE, fetchImpl: fetchMock, refreshPath: PLATFORM_REFRESH_PATH },
      { read: async () => tokens, write },
      '/platform/dashboard',
    );
    expect(result.data.ok).toBe(true);
    expect(calls).toEqual([`${BASE}/platform/dashboard`, `${BASE}/platform/auth/refresh`, `${BASE}/platform/dashboard`]);
    expect(write).toHaveBeenCalledTimes(1);
  });
});
