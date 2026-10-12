import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES } from '@ghmt/shared';
import { ApiError } from '@/lib/api/errors';
import {
  DOCUMENT_MESSAGES,
  checkUploadFile,
  describeDocumentError,
  documentContentHref,
  formatFileSize,
  safeDownloadHeaders,
  toPatientDocuments,
} from './documents';

const PATIENT = '3f2b8c1e-1a2b-4c3d-8e9f-0123456789ab';
const DOC = '0192f0a0-0000-7000-8000-000000000001';
const VIEW = {
  id: DOC,
  purpose: 'identity',
  status: 'available',
  originalName: 'Carte.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 2048,
  createdAt: '2026-10-11T10:00:00.000Z',
  createdBy: { id: '0192f0a0-0000-7000-8000-000000000002', fullName: 'Awa Diop' },
};

describe('toPatientDocuments', () => {
  it('lit la liste de l’API et compte les éléments invalides au lieu de les faire disparaître en silence', () => {
    expect(toPatientDocuments({ items: [VIEW, { ...VIEW, status: 'rejected' }, null] })).toEqual({ documents: [VIEW], skipped: 2 });
  });

  it('ne signale rien quand tous les éléments sont valides', () => {
    expect(toPatientDocuments({ items: [VIEW] })).toEqual({ documents: [VIEW], skipped: 0 });
  });

  it('renvoie une liste vide sans compteur pour une réponse absente ou mal formée', () => {
    expect(toPatientDocuments(null)).toEqual({ documents: [], skipped: 0 });
    expect(toPatientDocuments({ items: 'x' })).toEqual({ documents: [], skipped: 0 });
  });
});

describe('checkUploadFile (contrôle côté navigateur et côté BFF)', () => {
  it('refuse l’absence de fichier, un fichier vide ou trop volumineux', () => {
    expect(checkUploadFile(null)).toBe('Choisissez un fichier à déposer.');
    expect(checkUploadFile({ size: 0 })).toBe('Choisissez un fichier à déposer.');
    expect(checkUploadFile({ size: MAX_UPLOAD_BYTES + 1 })).toBe(DOCUMENT_MESSAGES.file_too_large);
    expect(checkUploadFile({ size: MAX_UPLOAD_BYTES })).toBeNull();
  });
});

describe('describeDocumentError', () => {
  it.each([
    ['file_too_large', 413, 'Fichier trop volumineux (10 Mo au plus)'],
    ['type_not_allowed', 415, 'Type de fichier non accepté (PDF, JPEG, PNG, WebP)'],
    ['infected', 422, 'Fichier refusé par l’analyse antivirus'],
    ['plan_limit_reached', 403, 'Espace de stockage de votre abonnement atteint'],
  ])('traduit %s', (code, status, message) => {
    expect(describeDocumentError(new ApiError({ status, code }))).toBe(message);
  });

  it('renvoie null pour les erreurs génériques (traitées par le message commun)', () => {
    expect(describeDocumentError(new ApiError({ status: 403, code: 'permission_denied' }))).toBeNull();
  });
});

describe('documentContentHref et formatFileSize', () => {
  it('construit le lien BFF du téléchargement (aucune URL de stockage)', () => {
    expect(documentContentHref(PATIENT, DOC)).toBe(`/patients/${PATIENT}/documents/${DOC}/contenu`);
  });

  it('affiche la taille en octets, Ko ou Mo', () => {
    expect(formatFileSize(512)).toBe('512 o');
    expect(formatFileSize(2048)).toBe('2 Ko');
    expect(formatFileSize(3.5 * 1024 * 1024)).toBe('3,5 Mo');
  });
});

describe('safeDownloadHeaders (relais des en-têtes de l’API)', () => {
  it('relaie type, taille et disposition de l’API, avec nosniff et no-store', () => {
    const headers = safeDownloadHeaders(
      new Headers({ 'content-type': 'image/png', 'content-length': '42', 'content-disposition': 'attachment; filename="a.png"', 'set-cookie': 'x=y' }),
    );

    expect(Object.fromEntries(headers.entries())).toEqual({
      'cache-control': 'no-store',
      'content-disposition': 'attachment; filename="a.png"',
      'content-length': '42',
      'content-type': 'image/png',
      'x-content-type-options': 'nosniff',
    });
  });

  it('force un type neutre et une disposition attachment si l’API renvoie autre chose', () => {
    const headers = safeDownloadHeaders(new Headers({ 'content-type': 'text/html', 'content-disposition': 'inline' }));

    expect(headers.get('content-type')).toBe('application/octet-stream');
    expect(headers.get('content-disposition')).toBe('attachment');
    expect(headers.get('content-length')).toBeNull();
  });
});
