import type { TokenPair } from '../api/types';

export const DEFAULT_ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_COOKIE_TTL_SECONDS = 7 * 24 * 60 * 60;
export const MFA_CHALLENGE_TTL_SECONDS = 5 * 60;

export interface CookieOptions {
  readonly httpOnly: true;
  readonly secure: boolean;
  readonly sameSite: 'lax' | 'strict';
  readonly path: '/';
  readonly maxAge: number;
}

export interface CookieSpec {
  readonly name: string;
  readonly value: string;
  readonly options: CookieOptions;
}

export interface CookieNames {
  readonly access: string;
  readonly refresh: string;
  readonly mfaChallenge: string;
}

/** docs/04 §1.12 : préfixe __Host- (Secure, Path=/, sans Domain) dès que HTTPS est actif. */
export function cookieNames(secure: boolean): CookieNames {
  const prefix = secure ? '__Host-' : '';
  return {
    access: `${prefix}ghmt_at`,
    refresh: `${prefix}ghmt_rt`,
    mfaChallenge: `${prefix}ghmt_mfa`,
  };
}

export function cookieSpec(name: string, value: string, secure: boolean, sameSite: 'lax' | 'strict', maxAge: number): CookieSpec {
  return { name, value, options: { httpOnly: true, secure, sameSite, path: '/', maxAge } };
}

/** Jeton d'accès : SameSite=Lax ; refresh token : SameSite=Strict (docs/04 §1.12). */
export function sessionCookies(pair: TokenPair, secure: boolean): CookieSpec[] {
  const names = cookieNames(secure);
  const accessTtl = pair.expiresIn && pair.expiresIn > 0 ? Math.floor(pair.expiresIn) : DEFAULT_ACCESS_TTL_SECONDS;
  return [
    cookieSpec(names.access, pair.accessToken, secure, 'lax', accessTtl),
    cookieSpec(names.refresh, pair.refreshToken, secure, 'strict', REFRESH_COOKIE_TTL_SECONDS),
  ];
}

export function accessCookie(accessToken: string, secure: boolean, expiresIn?: number): CookieSpec {
  const ttl = expiresIn && expiresIn > 0 ? Math.floor(expiresIn) : DEFAULT_ACCESS_TTL_SECONDS;
  return cookieSpec(cookieNames(secure).access, accessToken, secure, 'lax', ttl);
}

/** Le défi MFA reste côté serveur : le navigateur ne le voit jamais dans une réponse ou un formulaire. */
export function mfaChallengeCookie(challengeId: string, secure: boolean): CookieSpec {
  return cookieSpec(cookieNames(secure).mfaChallenge, challengeId, secure, 'strict', MFA_CHALLENGE_TTL_SECONDS);
}

export function expiredCookies(secure: boolean, which: readonly (keyof CookieNames)[]): CookieSpec[] {
  const names = cookieNames(secure);
  return which.map((key) => cookieSpec(names[key], '', secure, 'strict', 0));
}

export const SESSION_COOKIE_KEYS = ['access', 'refresh', 'mfaChallenge'] as const;
