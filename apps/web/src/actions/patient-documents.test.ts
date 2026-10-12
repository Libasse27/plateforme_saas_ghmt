import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_UPLOAD_BYTES } from '@ghmt/shared';
import { jsonResponse, okEnvelope, problem } from '@/lib/api/test-helpers';

vi.mock('next/navigation', async () => (await import('./test-kit')).navigationMock());
vi.mock('next/cache', async () => (await import('./test-kit')).cacheMock());
vi.mock('next/headers', async () => (await import('./test-kit')).headersMock());

import { revalidatePath } from 'next/cache';
import { deleteDocumentAction, uploadDocumentAction } from './patient-documents';
import { form, redirectOf, stubApi } from './test-kit';

const PATIENT = '3f2b8c1e-1a2b-4c3d-8e9f-0123456789ab';
const DOC = '0192f0a0-0000-7000-8000-000000000001';
const UPLOAD_PATH = `/patients/${PATIENT}/documents`;

function uploadForm(file: File | null, fields: Record<string, string> = {}): FormData {
  const data = form({ patientId: PATIENT, purpose: 'identity', ...fields });
  if (file) data.set('file', file);
  return data;
}

const pdfFile = (size = 64) => new File([new Uint8Array(size)], 'Carte d’identité.pdf', { type: 'application/pdf' });

beforeEach(() => {
  vi.stubEnv('API_URL', 'http://api.test/api/v1');
  vi.stubEnv('SESSION_COOKIE_SECURE', 'false');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.mocked(revalidatePath).mockClear();
});

describe('uploadDocumentAction', () => {
  it('relaie le fichier et l’usage en multipart avec le jeton du cookie, puis rafraîchit la fiche', async () => {
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname.replace(/^\/api\/v1/, '');
      if (path === '/auth/me') return okEnvelope({});
      bodies.push(init?.body);
      return okEnvelope({ id: DOC, status: 'available' }, {}, 201);
    });
    vi.stubGlobal('fetch', fetchMock);

    const state = await uploadDocumentAction({}, uploadForm(pdfFile()));

    expect(state).toEqual({ ok: true, message: 'Document déposé.' });
    const call = fetchMock.mock.calls.find(([input]) => String(input).endsWith(UPLOAD_PATH));
    expect(call?.[1]?.method).toBe('POST');
    expect((call?.[1]?.headers as Record<string, string>).authorization).toBe('Bearer tenant-access');
    const sent = bodies[0] as FormData;
    expect(sent.get('purpose')).toBe('identity');
    expect((sent.get('file') as File).name).toBe('Carte d’identité.pdf');
    expect(revalidatePath).toHaveBeenCalledWith(`/patients/${PATIENT}`);
  });

  it('annonce l’analyse en cours quand le document est « pending »', async () => {
    stubApi((c) => (c.path === UPLOAD_PATH ? okEnvelope({ id: DOC, status: 'pending' }, {}, 201) : undefined));

    expect(await uploadDocumentAction({}, uploadForm(pdfFile()))).toEqual({ ok: true, message: 'Document déposé : analyse antivirus en cours.' });
  });

  it('refuse sans appel à l’API un fichier absent, vide ou trop volumineux, un usage ou un patient invalide', async () => {
    const { calls } = stubApi(() => undefined);

    expect((await uploadDocumentAction({}, uploadForm(null))).message).toBe('Choisissez un fichier à déposer.');
    expect((await uploadDocumentAction({}, uploadForm(pdfFile(0)))).message).toBe('Choisissez un fichier à déposer.');
    expect((await uploadDocumentAction({}, uploadForm(pdfFile(MAX_UPLOAD_BYTES + 1)))).message).toBe('Fichier trop volumineux (10 Mo au plus)');
    expect((await uploadDocumentAction({}, uploadForm(pdfFile(), { purpose: 'clinical' }))).ok).toBe(false);
    expect((await uploadDocumentAction({}, uploadForm(pdfFile(), { patientId: '../x' }))).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it.each([
    [415, 'type_not_allowed', 'Type de fichier non accepté (PDF, JPEG, PNG, WebP)'],
    [422, 'infected', 'Fichier refusé par l’analyse antivirus'],
    [403, 'plan_limit_reached', 'Espace de stockage de votre abonnement atteint'],
    [413, 'file_too_large', 'Fichier trop volumineux (10 Mo au plus)'],
  ])('traduit le refus %i %s', async (status, code, message) => {
    stubApi((c) => (c.path === UPLOAD_PATH ? problem(status, code) : undefined));

    expect(await uploadDocumentAction({}, uploadForm(pdfFile()))).toMatchObject({ ok: false, message });
  });

  it('utilise le message commun pour un refus de droits', async () => {
    stubApi((c) => (c.path === UPLOAD_PATH ? problem(403, 'permission_denied') : undefined));

    expect((await uploadDocumentAction({}, uploadForm(pdfFile()))).message).toContain('autorisation');
  });

  it('signale un service injoignable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith('/auth/me')) return okEnvelope({});
        throw new TypeError('fetch failed');
      }),
    );

    expect((await uploadDocumentAction({}, uploadForm(pdfFile()))).message).toContain('injoignable');
  });

  it('renvoie vers la connexion si la session est perdue', async () => {
    stubApi(() => undefined, null);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { success: false, error: { status: 401, code: 'unauthenticated' } })));

    expect(await redirectOf(uploadDocumentAction({}, uploadForm(pdfFile())))).toBe('/connexion?session=expiree');
  });
});

describe('deleteDocumentAction', () => {
  it('supprime avec le motif dans le corps (DELETE), puis rafraîchit la fiche', async () => {
    const { calls } = stubApi((c) => (c.path === `${UPLOAD_PATH}/${DOC}` ? new Response(null, { status: 204 }) : undefined));

    const state = await deleteDocumentAction({}, form({ patientId: PATIENT, documentId: DOC, reason: '  Pièce périmée  ' }));

    expect(state).toEqual({ ok: true, message: 'Document supprimé.' });
    expect(calls.find((c) => c.method === 'DELETE')?.body).toEqual({ reason: 'Pièce périmée' });
    expect(revalidatePath).toHaveBeenCalledWith(`/patients/${PATIENT}`);
  });

  it('exige un motif de 5 à 500 caractères et des identifiants valides, sans appel', async () => {
    const { calls } = stubApi(() => undefined);

    const short = await deleteDocumentAction({}, form({ patientId: PATIENT, documentId: DOC, reason: 'non' }));
    const invalid = await deleteDocumentAction({}, form({ patientId: PATIENT, documentId: 'x', reason: 'Pièce périmée' }));

    expect(short).toMatchObject({ ok: false, fieldErrors: { reason: 'Indiquez le motif de la suppression (5 à 500 caractères).' } });
    expect(invalid.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('traduit un document introuvable', async () => {
    stubApi((c) => (c.path === `${UPLOAD_PATH}/${DOC}` ? problem(404, 'document_not_found') : undefined));

    expect((await deleteDocumentAction({}, form({ patientId: PATIENT, documentId: DOC, reason: 'Pièce périmée' }))).message).toBe(
      'Ce document est introuvable ou n’est pas encore disponible.',
    );
  });
});
