'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { deleteDocumentSchema, filePurposeSchema } from '@ghmt/shared';
import { buildUrl, requestWithSession } from '@/lib/api/client';
import { forwardHeaders } from '@/lib/api/client-info';
import { readEnvelope } from '@/lib/api/envelope';
import { ApiError, isApiError } from '@/lib/api/errors';
import type { ApiSuccess } from '@/lib/api/types';
import { checkUploadFile, describeDocumentError } from '@/lib/documents/documents';
import { formDataToFlat, type FormState } from '@/lib/forms';
import { cookieTokenStore } from '@/lib/session/store';
import { actionApi, apiDeps } from '@/server/api';
import { INVALID_REQUEST, pathId } from './context';
import { failureState } from './helpers';

/** Un dépôt de 10 Mo sur une liaison lente, puis l'analyse antivirus (30 s au plus côté API). */
const UPLOAD_TIMEOUT_MS = 90_000;
const SESSION_EXPIRED_PATH = '/connexion?session=expiree';
const REASON_MESSAGE = 'Indiquez le motif de la suppression (5 à 500 caractères).';

function documentFailure(error: unknown): FormState {
  if (isApiError(error)) {
    const message = describeDocumentError(error);
    if (message) return { ok: false, message };
  }
  return failureState(error);
}

/**
 * Envoi multipart à l'API avec le jeton du cookie (jamais exposé au navigateur). La session est d'abord validée, et
 * rafraîchie si besoin, par `/auth/me` : le corps du fichier n'est envoyé qu'une fois.
 */
async function postMultipart(path: string, body: FormData): Promise<ApiSuccess<{ status?: unknown }>> {
  const deps = await apiDeps();
  const store = cookieTokenStore({ persist: true });
  try {
    await requestWithSession(deps, store, '/auth/me');
  } catch (error) {
    if (isApiError(error) && error.status === 401) redirect(SESSION_EXPIRED_PATH);
    throw error;
  }
  const { accessToken } = await store.read();
  let response: Response;
  try {
    response = await fetch(buildUrl(deps.baseUrl, path), {
      method: 'POST',
      headers: { accept: 'application/json', ...forwardHeaders(deps.clientInfo), ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    throw error instanceof DOMException && error.name === 'TimeoutError' ? ApiError.timeout() : ApiError.network();
  }
  return readEnvelope(response);
}

/** Dépôt d'un document administratif (docs/13 §9) : taille contrôlée ici avant tout envoi, type réel contrôlé par l'API. */
export async function uploadDocumentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const patientId = pathId(flat.patientId);
  const purpose = filePurposeSchema.safeParse(flat.purpose);
  const file = formData.get('file');
  if (!patientId || !purpose.success) return INVALID_REQUEST;
  const upload = file instanceof File ? file : null;
  const invalid = checkUploadFile(upload);
  if (invalid || !upload) return { ok: false, message: invalid ?? INVALID_REQUEST.message };

  const body = new FormData();
  body.set('purpose', purpose.data);
  body.set('file', upload, upload.name);
  let status: unknown;
  try {
    status = (await postMultipart(`/patients/${patientId}/documents`, body)).data?.status;
  } catch (error) {
    return documentFailure(error);
  }
  revalidatePath(`/patients/${patientId}`);
  return { ok: true, message: status === 'pending' ? 'Document déposé : analyse antivirus en cours.' : 'Document déposé.' };
}

/** Suppression avec motif (agent administratif) : le motif part dans le corps, consigné dans l'audit. */
export async function deleteDocumentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const patientId = pathId(flat.patientId);
  const documentId = pathId(flat.documentId);
  if (!patientId || !documentId) return INVALID_REQUEST;
  const input = deleteDocumentSchema.safeParse({ reason: flat.reason ?? '' });
  if (!input.success) return { ok: false, message: REASON_MESSAGE, fieldErrors: { reason: REASON_MESSAGE }, values: { reason: flat.reason ?? '' } };
  try {
    await actionApi(`/patients/${patientId}/documents/${documentId}`, { method: 'DELETE', body: input.data });
  } catch (error) {
    return documentFailure(error);
  }
  revalidatePath(`/patients/${patientId}`);
  return { ok: true, message: 'Document supprimé.' };
}
