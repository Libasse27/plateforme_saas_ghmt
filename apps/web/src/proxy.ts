import { NextResponse, type NextRequest } from 'next/server';
import { extractClientInfo } from '@/lib/api/client-info';
import { isApiError } from '@/lib/api/errors';
import { PLATFORM_REFRESH_PATH, refreshSession, TENANT_REFRESH_PATH } from '@/lib/api/refresh';
import type { TokenPair } from '@/lib/api/types';
import { getApiUrl, isSecureCookies } from '@/lib/config';
import { cookieNames, expiredCookies, sessionCookies, SESSION_COOKIE_KEYS, type CookieSpec } from '@/lib/session/cookies';
import {
  expiredPlatformCookies,
  PLATFORM_COOKIE_KEYS,
  platformCookieNames,
  platformSessionCookies,
} from '@/lib/session/platform-cookies';

/**
 * Deux espaces strictement séparés : l'établissement (cookies `ghmt_at`/`ghmt_rt`) et la console plateforme
 * (`/plateforme/*`, cookies `ghmt_pat`/`ghmt_prt`). Chaque espace ne lit que ses propres cookies : une session
 * établissement ne donne jamais accès à `/plateforme/*`, et inversement.
 */
const PLATFORM_ROOT = '/plateforme';

interface Realm {
  readonly loginPath: string;
  readonly homePath: string;
  readonly publicPrefixes: readonly string[];
  /** Pages réservées aux visiteurs sans session (renvoyées vers l'accueil si connecté). */
  readonly authOnlyPages: ReadonlySet<string>;
  readonly refreshPath: string;
  readonly accessCookie: (secure: boolean) => string;
  readonly refreshCookie: (secure: boolean) => string;
  readonly sessionCookies: (pair: TokenPair, secure: boolean) => CookieSpec[];
  readonly expiredCookies: (secure: boolean) => CookieSpec[];
}

const TENANT_REALM: Realm = {
  loginPath: '/connexion',
  homePath: '/',
  // /sandbox : page de développement du fournisseur de paiement simulé (404 en production, rendu par la page).
  publicPrefixes: ['/connexion', '/inscription', '/session/expire', '/invitation', '/sandbox'],
  authOnlyPages: new Set(['/connexion', '/inscription']),
  refreshPath: TENANT_REFRESH_PATH,
  accessCookie: (secure) => cookieNames(secure).access,
  refreshCookie: (secure) => cookieNames(secure).refresh,
  sessionCookies,
  expiredCookies: (secure) => expiredCookies(secure, SESSION_COOKIE_KEYS),
};

const PLATFORM_REALM: Realm = {
  loginPath: `${PLATFORM_ROOT}/connexion`,
  homePath: PLATFORM_ROOT,
  publicPrefixes: [`${PLATFORM_ROOT}/connexion`, `${PLATFORM_ROOT}/session/expire`],
  authOnlyPages: new Set([`${PLATFORM_ROOT}/connexion`]),
  refreshPath: PLATFORM_REFRESH_PATH,
  accessCookie: (secure) => platformCookieNames(secure).access,
  refreshCookie: (secure) => platformCookieNames(secure).refresh,
  sessionCookies: platformSessionCookies,
  expiredCookies: (secure) => expiredPlatformCookies(secure, PLATFORM_COOKIE_KEYS),
};

function realmFor(pathname: string): Realm {
  return pathname === PLATFORM_ROOT || pathname.startsWith(`${PLATFORM_ROOT}/`) ? PLATFORM_REALM : TENANT_REALM;
}

function isPublic(realm: Realm, pathname: string): boolean {
  return realm.publicPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function applyToResponse(response: NextResponse, specs: readonly CookieSpec[]): NextResponse {
  for (const { name, value, options } of specs) response.cookies.set(name, value, options);
  return response;
}

function redirectToLogin(realm: Realm, request: NextRequest, secure: boolean, clear: boolean): NextResponse {
  const url = request.nextUrl.clone();
  const target = `${url.pathname}${url.search}`;
  url.pathname = realm.loginPath;
  url.search = '';
  if (target !== realm.homePath) url.searchParams.set('next', target);
  if (clear) url.searchParams.set('session', 'expiree');
  const response = NextResponse.redirect(url);
  return clear ? applyToResponse(response, realm.expiredCookies(secure)) : response;
}

/**
 * Garde de session (anciennement middleware) : sans session, redirection vers la connexion de l'espace ;
 * jeton d'accès expiré (cookie disparu) mais refresh token présent, rafraîchissement transparent
 * avant le rendu, ce qui évite d'écrire des cookies depuis les composants serveur.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const secure = isSecureCookies();
  const { pathname } = request.nextUrl;
  const realm = realmFor(pathname);
  const accessToken = request.cookies.get(realm.accessCookie(secure))?.value;
  const refreshToken = request.cookies.get(realm.refreshCookie(secure))?.value;

  if (isPublic(realm, pathname)) {
    const isNavigation = request.method === 'GET' || request.method === 'HEAD';
    if (accessToken && isNavigation && realm.authOnlyPages.has(pathname)) {
      return NextResponse.redirect(new URL(realm.homePath, request.url));
    }
    return NextResponse.next();
  }

  if (accessToken) return NextResponse.next();
  if (!refreshToken) return redirectToLogin(realm, request, secure, false);

  try {
    const pair = await refreshSession(
      { baseUrl: getApiUrl(), clientInfo: extractClientInfo(request.headers), refreshPath: realm.refreshPath },
      refreshToken,
    );
    const specs = realm.sessionCookies(pair, secure);
    for (const { name, value } of specs) request.cookies.set(name, value);
    return applyToResponse(NextResponse.next({ request: { headers: request.headers } }), specs);
  } catch (error) {
    // Seul un refus explicite du refresh token purge la session ; une panne réseau la conserve.
    const sessionLost = isApiError(error) && (error.status === 401 || error.status === 403);
    return redirectToLogin(realm, request, secure, sessionLost);
  }
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)'],
};
