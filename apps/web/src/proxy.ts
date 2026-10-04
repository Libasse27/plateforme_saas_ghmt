import { NextResponse, type NextRequest } from 'next/server';
import { extractClientInfo } from '@/lib/api/client-info';
import { isApiError } from '@/lib/api/errors';
import { refreshSession } from '@/lib/api/refresh';
import { getApiUrl, isSecureCookies } from '@/lib/config';
import { cookieNames, expiredCookies, sessionCookies, SESSION_COOKIE_KEYS, type CookieSpec } from '@/lib/session/cookies';

const PUBLIC_PREFIXES = ['/connexion', '/inscription', '/session/expire', '/invitation'] as const;
const AUTH_ONLY_PAGES: ReadonlySet<string> = new Set(['/connexion', '/inscription']);

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function applyToResponse(response: NextResponse, specs: readonly CookieSpec[]): NextResponse {
  for (const { name, value, options } of specs) response.cookies.set(name, value, options);
  return response;
}

function redirectToLogin(request: NextRequest, secure: boolean, clear: boolean): NextResponse {
  const url = request.nextUrl.clone();
  const target = `${url.pathname}${url.search}`;
  url.pathname = '/connexion';
  url.search = '';
  if (target !== '/') url.searchParams.set('next', target);
  if (clear) url.searchParams.set('session', 'expiree');
  const response = NextResponse.redirect(url);
  return clear ? applyToResponse(response, expiredCookies(secure, SESSION_COOKIE_KEYS)) : response;
}

/**
 * Garde de session (anciennement middleware) : sans session, redirection vers /connexion ;
 * jeton d'accès expiré (cookie disparu) mais refresh token présent, rafraîchissement transparent
 * avant le rendu, ce qui évite d'écrire des cookies depuis les composants serveur.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const secure = isSecureCookies();
  const names = cookieNames(secure);
  const { pathname } = request.nextUrl;
  const accessToken = request.cookies.get(names.access)?.value;
  const refreshToken = request.cookies.get(names.refresh)?.value;

  if (isPublic(pathname)) {
    const isNavigation = request.method === 'GET' || request.method === 'HEAD';
    if (accessToken && isNavigation && AUTH_ONLY_PAGES.has(pathname)) {
      return NextResponse.redirect(new URL('/', request.url));
    }
    return NextResponse.next();
  }

  if (accessToken) return NextResponse.next();
  if (!refreshToken) return redirectToLogin(request, secure, false);

  try {
    const pair = await refreshSession({ baseUrl: getApiUrl(), clientInfo: extractClientInfo(request.headers) }, refreshToken);
    const specs = sessionCookies(pair, secure);
    for (const { name, value } of specs) request.cookies.set(name, value);
    return applyToResponse(NextResponse.next({ request: { headers: request.headers } }), specs);
  } catch (error) {
    // Seul un refus explicite du refresh token purge la session ; une panne réseau la conserve.
    const sessionLost = isApiError(error) && (error.status === 401 || error.status === 403);
    return redirectToLogin(request, secure, sessionLost);
  }
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)'],
};
