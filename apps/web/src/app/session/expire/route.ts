import { NextResponse, type NextRequest } from 'next/server';
import { isSecureCookies } from '@/lib/config';
import { SESSION_COOKIE_KEYS, expiredCookies } from '@/lib/session/cookies';

/** Purge les cookies d'une session perdue (impossible depuis le rendu) puis renvoie vers la connexion. */
export function GET(request: NextRequest) {
  const response = NextResponse.redirect(new URL('/connexion?session=expiree', request.url));
  for (const { name, value, options } of expiredCookies(isSecureCookies(), SESSION_COOKIE_KEYS)) {
    response.cookies.set(name, value, options);
  }
  response.headers.set('cache-control', 'no-store');
  return response;
}
