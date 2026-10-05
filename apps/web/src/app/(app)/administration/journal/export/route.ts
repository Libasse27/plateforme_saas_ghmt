import { NextResponse } from 'next/server';
import { buildUrl, requestWithSession } from '@/lib/api/client';
import { forwardHeaders } from '@/lib/api/client-info';
import { readEnvelope } from '@/lib/api/envelope';
import { ApiError, isApiError } from '@/lib/api/errors';
import { parseMe } from '@/lib/auth/me';
import { auditExportFilters, exportFailureHref, exportFailureKey, exportHeaders, isSameOriginRequest, parseAuditFilters } from '@/lib/domain/audit';
import { formDataToFlat } from '@/lib/forms';
import { apiDeps } from '@/server/api';
import { cookieTokenStore } from '@/lib/session/store';

export const dynamic = 'force-dynamic';

const SESSION_EXPIRED_PATH = '/session/expire';
const FORBIDDEN_STATUS = 403;
const EXPORT_TIMEOUT_MS = 60_000;

function redirectTo(request: Request, path: string): NextResponse {
  return NextResponse.redirect(new URL(path, request.url), 303);
}

/** L'API répond en CSV (non enveloppé) : un appel direct avec le jeton du cookie, jamais exposé au navigateur. */
async function fetchExport(token: string | undefined, body: unknown): Promise<Response> {
  const deps = await apiDeps();
  try {
    return await fetch(buildUrl(deps.baseUrl, '/audit-logs/export'), {
      method: 'POST',
      headers: { accept: 'text/csv', 'content-type': 'application/json', ...forwardHeaders(deps.clientInfo), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
    });
  } catch {
    throw ApiError.network();
  }
}

/**
 * Export CSV du journal d'audit. POST uniquement, avec contrôle Fetch Metadata puis Origin (anti-CSRF : le cookie
 * de session part automatiquement avec un formulaire d'un autre site). Les filtres passent par une liste blanche.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request.headers)) {
    return NextResponse.json({ message: 'Origine de la requête refusée.' }, { status: FORBIDDEN_STATUS, headers: { 'cache-control': 'no-store' } });
  }
  const flat = formDataToFlat(await request.formData());
  const filters = parseAuditFilters(flat);
  const store = cookieTokenStore({ persist: false });
  try {
    const deps = await apiDeps();
    const me = parseMe((await requestWithSession(deps, store, '/auth/me')).data);
    const response = await fetchExport((await store.read()).accessToken, auditExportFilters(flat, me.tenant.timezone));
    if (!response.ok) await readEnvelope(response); // lève l'ApiError correspondante
    return new Response(response.body, { status: 200, headers: exportHeaders(response.headers) });
  } catch (error) {
    if (!isApiError(error)) throw error;
    if (error.status === 401) return redirectTo(request, SESSION_EXPIRED_PATH);
    return redirectTo(request, exportFailureHref(filters, exportFailureKey(error)));
  }
}
