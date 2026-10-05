import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { okEnvelope, problem } from '@/lib/api/test-helpers';

vi.mock('next/headers', async () => (await import('@/actions/test-kit')).headersMock());

import { stubApi } from '@/actions/test-kit';
import { POST } from './route';

const ACTOR = '0190c1a0-1111-7000-8000-000000000001';
const CSV = '﻿seq;horodatage_utc\n1;2026-10-05T10:00:00.000Z\n';

function exportRequest(fields: Record<string, string>, headers: Record<string, string> = { origin: 'http://localhost:3001', host: 'localhost:3001' }): Request {
  const body = new URLSearchParams(fields);
  return new Request('http://localhost:3001/administration/journal/export', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body });
}

const csvResponse = () =>
  new Response(CSV, { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="journal-audit-20261001-20261005.csv"' } });

beforeEach(() => {
  vi.stubEnv('API_URL', 'http://api.test/api/v1');
  vi.stubEnv('SESSION_COOKIE_SECURE', 'false');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('POST /administration/journal/export', () => {
  it('relaie le CSV et ses en-têtes avec le jeton du cookie', async () => {
    const { calls } = stubApi((c) => (c.path === '/audit-logs/export' ? csvResponse() : undefined));
    const response = await POST(exportRequest({ du: '2026-10-01', au: '2026-10-05', acteur: ACTOR, action: 'auth.*' }));
    expect(response.status).toBe(200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)).toBe(CSV);
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="journal-audit-20261001-20261005.csv"');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const call = calls.find((c) => c.path === '/audit-logs/export');
    expect(call?.method).toBe('POST');
    expect(call?.authorization).toBe('Bearer tenant-access');
    expect(call?.body).toEqual({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-06T00:00:00.000Z', actorUserId: ACTOR, action: 'auth.*' });
  });
  it('ne transmet aucun champ hors liste blanche', async () => {
    const { calls } = stubApi((c) => (c.path === '/audit-logs/export' ? csvResponse() : undefined));
    await POST(exportRequest({ action: 'x.y', q: 'Awa DIOP', patientId: ACTOR, nom: 'Diop' }));
    expect(calls.find((c) => c.path === '/audit-logs/export')?.body).toEqual({ action: 'x.y' });
  });
  it('origine étrangère : 403 sans aucun appel à l\'API', async () => {
    const { calls } = stubApi(() => csvResponse());
    const response = await POST(exportRequest({}, { origin: 'https://evil.test', host: 'localhost:3001' }));
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });
  it('origine absente : 403', async () => {
    const { calls } = stubApi(() => csvResponse());
    expect((await POST(exportRequest({}, { host: 'localhost:3001' }))).status).toBe(403);
    expect(calls).toHaveLength(0);
  });
  it('Origin « null » (Referrer-Policy no-referrer) mais Sec-Fetch-Site same-origin : export accepté', async () => {
    stubApi((c) => (c.path === '/audit-logs/export' ? csvResponse() : undefined));
    const response = await POST(exportRequest({}, { origin: 'null', host: 'localhost:3001', 'sec-fetch-site': 'same-origin' }));
    expect(response.status).toBe(200);
  });
  it('Sec-Fetch-Site cross-site, same-site ou none : 403 même avec une origine identique', async () => {
    const { calls } = stubApi(() => csvResponse());
    for (const site of ['cross-site', 'same-site', 'none']) {
      const response = await POST(exportRequest({}, { origin: 'http://localhost:3001', host: 'localhost:3001', 'sec-fetch-site': site }));
      expect(response.status).toBe(403);
    }
    expect(calls).toHaveLength(0);
  });
  it('hôte transmis par le proxy (x-forwarded-host)', async () => {
    stubApi((c) => (c.path === '/audit-logs/export' ? csvResponse() : undefined));
    const response = await POST(exportRequest({}, { origin: 'https://app.ghmt.sn', host: 'internal:3001', 'x-forwarded-host': 'app.ghmt.sn' }));
    expect(response.status).toBe(200);
  });
  it('échecs de l\'API : retour au journal avec une clé fermée et les filtres', async () => {
    stubApi((c) => (c.path === '/audit-logs/export' ? problem(422, 'export_too_large', { details: { count: 25000, max: 10000 } }) : undefined));
    const tooLarge = await POST(exportRequest({ du: '2026-10-01' }));
    expect(tooLarge.status).toBe(303);
    expect(tooLarge.headers.get('location')).toBe('http://localhost:3001/administration/journal?du=2026-10-01&export=trop-volumineux');
    stubApi((c) => (c.path === '/audit-logs/export' ? problem(429, 'throttled') : undefined));
    expect((await POST(exportRequest({}))).headers.get('location')).toBe('http://localhost:3001/administration/journal?export=limite');
    stubApi((c) => (c.path === '/audit-logs/export' ? problem(403, 'subscription_grace') : undefined));
    expect((await POST(exportRequest({}))).headers.get('location')).toContain('export=abonnement');
  });
  it('session perdue : redirection vers l\'expiration de session', async () => {
    stubApi((c) => (c.path === '/audit-logs/export' ? problem(401, 'unauthenticated') : undefined));
    const response = await POST(exportRequest({}));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('http://localhost:3001/session/expire');
  });
  it('API injoignable : retour au journal avec la clé erreur', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/auth/me')) return okEnvelope({ user: { id: 'u' }, tenant: { timezone: 'Africa/Dakar' }, permissions: [], modules: [] });
      throw new TypeError('réseau');
    }));
    const response = await POST(exportRequest({}));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('export=erreur');
  });
});
