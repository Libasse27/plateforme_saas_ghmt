import { NextResponse, type NextRequest } from 'next/server';
import { isSecureCookies } from '@/lib/config';
import { expiredPlatformCookies, PLATFORM_COOKIE_KEYS } from '@/lib/session/platform-cookies';

/** Purge les cookies d'une session plateforme perdue (impossible depuis le rendu) puis renvoie vers la connexion plateforme. */
export function GET(request: NextRequest) {
  const response = NextResponse.redirect(new URL('/plateforme/connexion?session=expiree', request.url));
  for (const { name, value, options } of expiredPlatformCookies(isSecureCookies(), PLATFORM_COOKIE_KEYS)) {
    response.cookies.set(name, value, options);
  }
  response.headers.set('cache-control', 'no-store');
  return response;
}
