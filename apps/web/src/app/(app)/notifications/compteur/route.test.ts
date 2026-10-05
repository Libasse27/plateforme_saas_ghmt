import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { okEnvelope, problem } from '@/lib/api/test-helpers';

vi.mock('next/headers', async () => (await import('@/actions/test-kit')).headersMock());

import { stubApi } from '@/actions/test-kit';
import { GET } from './route';

beforeEach(() => {
  vi.stubEnv('API_URL', 'http://api.test/api/v1');
  vi.stubEnv('SESSION_COOKIE_SECURE', 'false');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('GET /notifications/compteur', () => {
  it('relaie le compteur avec le jeton du cookie, sans mise en cache', async () => {
    const { calls } = stubApi((c) => (c.path === '/notifications/inbox/unread-count' ? okEnvelope({ count: 7, capped: false }) : undefined));
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ count: 7, capped: false });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(calls.find((c) => c.path === '/notifications/inbox/unread-count')?.authorization).toBe('Bearer tenant-access');
  });
  it('normalise une réponse inattendue', async () => {
    stubApi(() => okEnvelope('bizarre'));
    expect(await (await GET()).json()).toEqual({ count: 0, capped: false });
  });
  it('transmet le 401 tel quel, sans redirection', async () => {
    stubApi(() => problem(401, 'unauthenticated'));
    const response = await GET();
    expect(response.status).toBe(401);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('autres erreurs : statut de l\'API ou 503 si injoignable, jamais de détail', async () => {
    stubApi(() => problem(403, 'permission_denied'));
    const forbidden = await GET();
    expect(forbidden.status).toBe(403);
    expect(JSON.stringify(await forbidden.json())).not.toContain('permission_denied');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('réseau'); }));
    expect((await GET()).status).toBe(503);
  });
});
