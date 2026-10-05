import type { TokenPair } from '../api/types';
import { DEFAULT_ACCESS_TTL_SECONDS, MFA_CHALLENGE_TTL_SECONDS, cookieSpec, type CookieSpec } from './cookies';

/** Session plateforme : 12 h (docs/03 §4.0). */
export const PLATFORM_REFRESH_COOKIE_TTL_SECONDS = 12 * 60 * 60;

export interface PlatformCookieNames {
  readonly access: string;
  readonly refresh: string;
  readonly mfaChallenge: string;
}

/**
 * Realm plateforme : cookies distincts de ceux de l'établissement (noms différents), donc une session
 * établissement n'est jamais lue pour /plateforme/* et inversement. Path=/ est imposé par le préfixe __Host-.
 */
export function platformCookieNames(secure: boolean): PlatformCookieNames {
  const prefix = secure ? '__Host-' : '';
  return { access: `${prefix}ghmt_pat`, refresh: `${prefix}ghmt_prt`, mfaChallenge: `${prefix}ghmt_pmfa` };
}

export const PLATFORM_COOKIE_KEYS = ['access', 'refresh', 'mfaChallenge'] as const;

function accessTtl(expiresIn: number | undefined): number {
  return expiresIn && expiresIn > 0 ? Math.floor(expiresIn) : DEFAULT_ACCESS_TTL_SECONDS;
}

export function platformSessionCookies(pair: TokenPair, secure: boolean): CookieSpec[] {
  const names = platformCookieNames(secure);
  return [
    cookieSpec(names.access, pair.accessToken, secure, 'lax', accessTtl(pair.expiresIn)),
    cookieSpec(names.refresh, pair.refreshToken, secure, 'strict', PLATFORM_REFRESH_COOKIE_TTL_SECONDS),
  ];
}

export function platformAccessCookie(accessToken: string, secure: boolean, expiresIn?: number): CookieSpec {
  return cookieSpec(platformCookieNames(secure).access, accessToken, secure, 'lax', accessTtl(expiresIn));
}

export function platformMfaChallengeCookie(challengeId: string, secure: boolean): CookieSpec {
  return cookieSpec(platformCookieNames(secure).mfaChallenge, challengeId, secure, 'strict', MFA_CHALLENGE_TTL_SECONDS);
}

export function expiredPlatformCookies(secure: boolean, which: readonly (keyof PlatformCookieNames)[]): CookieSpec[] {
  const names = platformCookieNames(secure);
  return which.map((key) => cookieSpec(names[key], '', secure, 'strict', 0));
}
