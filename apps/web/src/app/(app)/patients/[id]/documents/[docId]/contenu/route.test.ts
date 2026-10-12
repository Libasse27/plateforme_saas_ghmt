import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, okEnvelope, problem } from '@/lib/api/test-helpers';

vi.mock('next/headers', async () => (await import('@/actions/test-kit')).headersMock());

import { stubApi } from '@/actions/test-kit';
import { GET } from './route';

const PATIENT = '3f2b8c1e-1a2b-4c3d-8e9f-0123456789ab';
const DOC = '0192f0a0-0000-7000-8000-000000000001';
const CONTENT_PATH = `/patients/${PATIENT}/documents/${DOC}/content`;
const PDF = '%PDF-1.7\ncontenu\n%%EOF';

const params = (id = PATIENT, docId = DOC) => ({ params: Promise.resolve({ id, docId }) });
const downloadRequest = (headers: Record<string, string> = {}) =>
  new Request(`http://localhost:3001/patients/${PATIENT}/documents/${DOC}/contenu`, { headers });
const pdfResponse = () =>
  new Response(PDF, {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-length': String(PDF.length),
      'content-disposition': `attachment; filename="carte.pdf"; filename*=UTF-8''carte.pdf`,
      'set-cookie': 'fuite=1',
    },
  });

beforeEach(() => {
  vi.stubEnv('API_URL', 'http://api.test/api/v1');
  vi.stubEnv('SESSION_COOKIE_SECURE', 'false');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('GET /patients/[id]/documents/[docId]/contenu (relais BFF, docs/13 D3)', () => {
  it('relaie le flux et ses en-têtes avec le jeton du cookie, sans autre en-tête de l’API', async () => {
    const { calls } = stubApi((c) => (c.path === CONTENT_PATH ? pdfResponse() : undefined));

    const response = await GET(downloadRequest({ 'sec-fetch-site': 'same-origin' }), params());

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(PDF);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-disposition')).toBe(`attachment; filename="carte.pdf"; filename*=UTF-8''carte.pdf`);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(calls.find((c) => c.path === CONTENT_PATH)?.authorization).toBe('Bearer tenant-access');
  });

  it('refuse une requête d’un autre site (Sec-Fetch-Site cross-site) sans appel à l’API', async () => {
    const { calls } = stubApi(() => pdfResponse());

    expect((await GET(downloadRequest({ 'sec-fetch-site': 'cross-site' }), params())).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('répond 404 pour des identifiants invalides, sans appel', async () => {
    const { calls } = stubApi(() => pdfResponse());

    expect((await GET(downloadRequest(), params('../x'))).status).toBe(404);
    expect((await GET(downloadRequest(), params(PATIENT, 'x'))).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('répond 404 avec un message français pour un document absent ou en cours d’analyse', async () => {
    stubApi((c) => (c.path === CONTENT_PATH ? problem(404, 'document_not_found') : undefined));

    const response = await GET(downloadRequest(), params());

    expect(response.status).toBe(404);
    expect(await response.text()).toContain('introuvable');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('relaie un refus de droits ou une indisponibilité du stockage', async () => {
    stubApi((c) => (c.path === CONTENT_PATH ? problem(403, 'permission_denied') : undefined));
    expect((await GET(downloadRequest(), params())).status).toBe(403);

    stubApi((c) => (c.path === CONTENT_PATH ? problem(503, 'storage_unavailable') : undefined));
    const unavailable = await GET(downloadRequest(), params());
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).toContain('indisponible');
  });

  it('renvoie vers /session/expire si la session est perdue', async () => {
    stubApi(() => undefined, null);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { success: false, error: { status: 401, code: 'unauthenticated' } })));

    const response = await GET(downloadRequest(), params());

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('http://localhost:3001/session/expire');
  });

  it('répond 502 si l’API est injoignable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith('/auth/me')) return okEnvelope({});
        throw new TypeError('fetch failed');
      }),
    );

    expect((await GET(downloadRequest(), params())).status).toBe(502);
  });
});
