import { afterEach, describe, expect, it, vi } from 'vitest';
import { request, requestWithSession, type TokenStore } from './client';
import { okEnvelope } from './test-helpers';
import { refreshSession, resetRefreshCache } from './refresh';

const BASE = 'http://api.test/api/v1';
const clientInfo = { ip: '203.0.113.9', userAgent: 'Mozilla/5.0' };

afterEach(() => resetRefreshCache());

function headersOf(fetchImpl: ReturnType<typeof vi.fn>, call = 0): Record<string, string> {
  return (fetchImpl.mock.calls[call] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
}

describe('C9 : transmission de l\'IP client', () => {
  it('request ajoute X-Forwarded-For et User-Agent', async () => {
    const fetchImpl = vi.fn(async () => okEnvelope(null));
    await request({ baseUrl: BASE, fetchImpl, clientInfo }, '/auth/login', { method: 'POST', body: {} });
    expect(headersOf(fetchImpl)['x-forwarded-for']).toBe('203.0.113.9');
    expect(headersOf(fetchImpl)['user-agent']).toBe('Mozilla/5.0');
  });

  it('sans information client, n\'ajoute aucun de ces en-têtes', async () => {
    const fetchImpl = vi.fn(async () => okEnvelope(null));
    await request({ baseUrl: BASE, fetchImpl }, '/x');
    expect(headersOf(fetchImpl)['x-forwarded-for']).toBeUndefined();
  });

  it('transmet If-Match fourni par l\'appelant', async () => {
    const fetchImpl = vi.fn(async () => okEnvelope(null));
    await request({ baseUrl: BASE, fetchImpl }, '/patients/1', { method: 'PATCH', body: {}, headers: { 'if-match': '"3"' } });
    expect(headersOf(fetchImpl)['if-match']).toBe('"3"');
  });

  it('le rafraîchissement de session transmet aussi l\'IP', async () => {
    const fetchImpl = vi.fn(async () => okEnvelope({ accessToken: 'a', refreshToken: 'r' }));
    await refreshSession({ baseUrl: BASE, fetchImpl, clientInfo }, 'old');
    expect(headersOf(fetchImpl)['x-forwarded-for']).toBe('203.0.113.9');
  });

  it('requestWithSession propage les informations client à l\'appel et au rafraîchissement', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/auth/refresh') ? okEnvelope({ accessToken: 'a2', refreshToken: 'r2' }) : okEnvelope({ ok: true }),
    );
    const store: TokenStore = { read: async () => ({ refreshToken: 'r1' }), write: async () => undefined };
    await requestWithSession({ baseUrl: BASE, fetchImpl, clientInfo }, store, '/patients');
    expect(headersOf(fetchImpl, 0)['x-forwarded-for']).toBe('203.0.113.9');
    expect(headersOf(fetchImpl, 1)['x-forwarded-for']).toBe('203.0.113.9');
  });
});
