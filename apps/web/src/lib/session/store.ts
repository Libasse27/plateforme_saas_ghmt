import { cookies } from 'next/headers';
import { getApiUrl, isSecureCookies } from '../config';
import type { TokenStore } from '../api/client';
import type { TokenPair } from '../api/types';
import {
  SESSION_COOKIE_KEYS,
  accessCookie,
  cookieNames,
  expiredCookies,
  mfaChallengeCookie,
  sessionCookies,
  type CookieSpec,
} from './cookies';

export { getApiUrl };

async function applyCookies(specs: readonly CookieSpec[]): Promise<void> {
  const jar = await cookies();
  for (const { name, value, options } of specs) jar.set(name, value, options);
}

/** Magasin de jetons basé sur les cookies httpOnly ; `persist: false` pour le rendu serveur (cookies en lecture seule). */
export function cookieTokenStore(options: { persist: boolean }): TokenStore {
  const secure = isSecureCookies();
  const names = cookieNames(secure);
  const read: TokenStore['read'] = async () => {
    const jar = await cookies();
    return { accessToken: jar.get(names.access)?.value, refreshToken: jar.get(names.refresh)?.value };
  };
  if (!options.persist) return { read };
  return {
    read,
    write: (pair: TokenPair) => applyCookies(sessionCookies(pair, secure)),
    clear: () => applyCookies(expiredCookies(secure, SESSION_COOKIE_KEYS)),
  };
}

export async function storeSession(pair: TokenPair): Promise<void> {
  await applyCookies(sessionCookies(pair, isSecureCookies()));
}

export async function replaceAccessToken(accessToken: string): Promise<void> {
  await applyCookies([accessCookie(accessToken, isSecureCookies())]);
}

export async function clearSession(): Promise<void> {
  await applyCookies(expiredCookies(isSecureCookies(), SESSION_COOKIE_KEYS));
}

export async function storeMfaChallenge(challengeId: string): Promise<void> {
  await applyCookies([mfaChallengeCookie(challengeId, isSecureCookies())]);
}

export async function readRefreshToken(): Promise<string | undefined> {
  const jar = await cookies();
  return jar.get(cookieNames(isSecureCookies()).refresh)?.value;
}

export async function readMfaChallenge(): Promise<string | undefined> {
  const jar = await cookies();
  return jar.get(cookieNames(isSecureCookies()).mfaChallenge)?.value;
}

export async function clearMfaChallenge(): Promise<void> {
  await applyCookies(expiredCookies(isSecureCookies(), ['mfaChallenge']));
}
