import { NextResponse, type NextRequest } from 'next/server';
import { extractClientInfo } from '@/lib/api/client-info';
import { isApiError } from '@/lib/api/errors';
import { PLATFORM_REFRESH_PATH, refreshSession, TENANT_REFRESH_PATH } from '@/lib/api/refresh';
import type { TokenPair } from '@/lib/api/types';
import { getApiUrl, isSecureCookies } from '@/lib/config';
import { buildContentSecurityPolicy, cspHeaderName, generateNonce, readCspConfig, reportingEndpointsValue } from '@/lib/csp';
import { isFromTrustedEdge } from '@/lib/edge';
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
  publicPrefixes: ['/connexion', '/inscription', '/session/expire', '/invitation', '/sandbox', '/mot-de-passe-oublie', '/reinitialiser'],
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

/** Pages publiques dont l'URL porte un jeton à usage unique : jamais mises en cache, même sans session. */
const TOKEN_PAGE_PREFIXES: readonly string[] = ['/reinitialiser', '/inscription/confirmer', '/invitation'];
const NO_STORE = 'private, no-store';

/** Contexte de sécurité d'une requête : un nonce neuf et la CSP qui en découle (docs/11 D14). */
interface SecurityContext {
  readonly nonce: string;
  readonly policy: string;
  readonly headerName: string;
  readonly reportingEndpoints: string | null;
  readonly noStore: boolean;
}

function securityContext(pathname: string, realm: Realm): SecurityContext {
  const config = readCspConfig();
  const nonce = generateNonce();
  const publicPage = isPublic(realm, pathname);
  const tokenPage = TOKEN_PAGE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
  return {
    nonce,
    policy: buildContentSecurityPolicy({
      nonce,
      dev: process.env.NODE_ENV === 'development',
      reportUri: config.reportUri,
      formActionOrigins: config.formActionOrigins,
    }),
    headerName: cspHeaderName(config.mode),
    reportingEndpoints: reportingEndpointsValue(config.reportUri),
    noStore: !publicPage || tokenPage,
  };
}

/** Pose la CSP (et l'interdiction de mise en cache) sur la réponse, redirections comprises. */
function secured(response: NextResponse, context: SecurityContext): NextResponse {
  response.headers.set(context.headerName, context.policy);
  if (context.reportingEndpoints) response.headers.set('Reporting-Endpoints', context.reportingEndpoints);
  if (context.noStore) response.headers.set('Cache-Control', NO_STORE);
  return response;
}

/**
 * Poursuite vers la page : la CSP et le nonce sont aussi posés sur l'en-tête de REQUÊTE, car Next lit le nonce
 * dans cet en-tête pour l'appliquer à ses scripts et styles (guide CSP de Next, « Adding a nonce with Proxy »).
 */
function proceed(request: NextRequest, context: SecurityContext): NextResponse {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', context.nonce);
  requestHeaders.set(context.headerName, context.policy);
  return secured(NextResponse.next({ request: { headers: requestHeaders } }), context);
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

function forbidden(): NextResponse {
  return new NextResponse('Accès refusé.', {
    status: 403,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': NO_STORE },
  });
}

/**
 * Garde de session (anciennement middleware) : sans session, redirection vers la connexion de l'espace ;
 * jeton d'accès expiré (cookie disparu) mais refresh token présent, rafraîchissement transparent
 * avant le rendu, ce qui évite d'écrire des cookies depuis les composants serveur.
 * Pose aussi la CSP à nonce sur chaque réponse et refuse, en production, toute requête qui ne vient pas
 * du proxy de bordure (docs/11 D11 : sinon l'IP cliente serait forgeable).
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  if (process.env.NODE_ENV === 'production' && !isFromTrustedEdge(request.headers)) return forbidden();

  const secure = isSecureCookies();
  const { pathname } = request.nextUrl;
  const realm = realmFor(pathname);
  const context = securityContext(pathname, realm);
  const accessToken = request.cookies.get(realm.accessCookie(secure))?.value;
  const refreshToken = request.cookies.get(realm.refreshCookie(secure))?.value;

  if (isPublic(realm, pathname)) {
    const isNavigation = request.method === 'GET' || request.method === 'HEAD';
    if (accessToken && isNavigation && realm.authOnlyPages.has(pathname)) {
      return secured(NextResponse.redirect(new URL(realm.homePath, request.url)), context);
    }
    return proceed(request, context);
  }

  if (accessToken) return proceed(request, context);
  if (!refreshToken) return secured(redirectToLogin(realm, request, secure, false), context);

  try {
    const pair = await refreshSession(
      { baseUrl: getApiUrl(), clientInfo: extractClientInfo(request.headers), refreshPath: realm.refreshPath },
      refreshToken,
    );
    const specs = realm.sessionCookies(pair, secure);
    for (const { name, value } of specs) request.cookies.set(name, value);
    return applyToResponse(proceed(request, context), specs);
  } catch (error) {
    // Seul un refus explicite du refresh token purge la session ; une panne réseau la conserve.
    const sessionLost = isApiError(error) && (error.status === 401 || error.status === 403);
    return secured(redirectToLogin(realm, request, secure, sessionLost), context);
  }
}

/**
 * Les ressources statiques sont exclues par LISTE d'extensions : une exclusion de « tout chemin avec un point »
 * laisserait hors du proxy (donc sans CSP, sans no-store ni garde de bordure) les pages à jeton `<uuid>.<secret>`.
 * Le matcher doit rester un littéral (analysé statiquement par Next).
 */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:avif|css|gif|ico|jpe?g|js|map|mjs|png|svg|txt|webmanifest|webp|woff2?|xml)$).*)'],
};
