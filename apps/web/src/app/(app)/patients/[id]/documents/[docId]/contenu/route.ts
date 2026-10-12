import { NextResponse } from 'next/server';
import { buildUrl, requestWithSession } from '@/lib/api/client';
import { forwardHeaders } from '@/lib/api/client-info';
import { readEnvelope } from '@/lib/api/envelope';
import { ApiError, isApiError } from '@/lib/api/errors';
import { describeApiError } from '@/lib/api/messages';
import { describeDocumentError, safeDownloadHeaders } from '@/lib/documents/documents';
import { isUuid } from '@/lib/domain/raw';
import { cookieTokenStore } from '@/lib/session/store';
import { apiDeps } from '@/server/api';

export const dynamic = 'force-dynamic';

const SESSION_EXPIRED_PATH = '/session/expire';
const DOWNLOAD_TIMEOUT_MS = 60_000;
const BAD_GATEWAY = 502;

interface RouteContext {
  readonly params: Promise<{ id: string; docId: string }>;
}

function textResponse(status: number, message: string): Response {
  return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}

/** Le jeton du cookie n'est jamais exposé au navigateur : appel direct à l'API, flux relayé tel quel (docs/13 D3). */
async function fetchContent(path: string): Promise<Response> {
  const deps = await apiDeps();
  const store = cookieTokenStore({ persist: false });
  // Valide la session (401 ⇒ page d'expiration) avant d'ouvrir le flux du document.
  await requestWithSession(deps, store, '/auth/me');
  const { accessToken } = await store.read();
  try {
    return await fetch(buildUrl(deps.baseUrl, path), {
      headers: { accept: '*/*', ...forwardHeaders(deps.clientInfo), ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
      cache: 'no-store',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch {
    throw ApiError.network();
  }
}

/**
 * Téléchargement d'un document du patient par le BFF : aucune URL de stockage dans le HTML. Une requête venue d'un autre
 * site (Sec-Fetch-Site) est refusée : le lien n'est utilisable que depuis la fiche patient.
 */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  if (request.headers.get('sec-fetch-site') === 'cross-site') return textResponse(403, 'Origine de la requête refusée.');
  const { id, docId } = await context.params;
  if (!isUuid(id) || !isUuid(docId)) return textResponse(404, 'Document introuvable.');
  try {
    const response = await fetchContent(`/patients/${id}/documents/${docId}/content`);
    if (!response.ok) await readEnvelope(response); // lève l'ApiError correspondante
    return new Response(response.body, { status: 200, headers: safeDownloadHeaders(response.headers) });
  } catch (error) {
    if (!isApiError(error)) throw error;
    if (error.status === 401) return NextResponse.redirect(new URL(SESSION_EXPIRED_PATH, request.url), 303);
    return textResponse(error.status || BAD_GATEWAY, describeDocumentError(error) ?? describeApiError(error));
  }
}
