import { cookies } from 'next/headers';
import type { TokenStore } from '../api/client';
import type { TokenPair } from '../api/types';
import { isSecureCookies } from '../config';
import type { CookieSpec } from './cookies';
import {
  PLATFORM_COOKIE_KEYS,
  expiredPlatformCookies,
  platformAccessCookie,
  platformCookieNames,
  platformMfaChallengeCookie,
  platformSessionCookies,
} from './platform-cookies';

async function applyCookies(specs: readonly CookieSpec[]): Promise<void> {
  const jar = await cookies();
  for (const { name, value, options } of specs) jar.set(name, value, options);
}

/** Magasin de jetons du realm plateforme (cookies httpOnly distincts) ; `persist: false` pour le rendu serveur. */
export function platformTokenStore(options: { persist: boolean }): TokenStore {
  const secure = isSecureCookies();
  const names = platformCookieNames(secure);
  const read: TokenStore['read'] = async () => {
    const jar = await cookies();
    return { accessToken: jar.get(names.access)?.value, refreshToken: jar.get(names.refresh)?.value };
  };
  if (!options.persist) return { read };
  return {
    read,
    write: (pair: TokenPair) => applyCookies(platformSessionCookies(pair, secure)),
    clear: () => applyCookies(expiredPlatformCookies(secure, PLATFORM_COOKIE_KEYS)),
  };
}

export async function storePlatformSession(pair: TokenPair): Promise<void> {
  await applyCookies(platformSessionCookies(pair, isSecureCookies()));
}

export async function replacePlatformAccessToken(accessToken: string, expiresIn?: number): Promise<void> {
  await applyCookies([platformAccessCookie(accessToken, isSecureCookies(), expiresIn)]);
}

export async function clearPlatformSession(): Promise<void> {
  await applyCookies(expiredPlatformCookies(isSecureCookies(), PLATFORM_COOKIE_KEYS));
}

export async function storePlatformMfaChallenge(challengeId: string): Promise<void> {
  await applyCookies([platformMfaChallengeCookie(challengeId, isSecureCookies())]);
}

export async function readPlatformRefreshToken(): Promise<string | undefined> {
  const jar = await cookies();
  return jar.get(platformCookieNames(isSecureCookies()).refresh)?.value;
}

export async function readPlatformMfaChallenge(): Promise<string | undefined> {
  const jar = await cookies();
  return jar.get(platformCookieNames(isSecureCookies()).mfaChallenge)?.value;
}

export async function clearPlatformMfaChallenge(): Promise<void> {
  await applyCookies(expiredPlatformCookies(isSecureCookies(), ['mfaChallenge']));
}
