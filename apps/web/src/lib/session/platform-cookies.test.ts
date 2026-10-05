import { describe, expect, it } from 'vitest';
import { cookieNames } from './cookies';
import {
  PLATFORM_COOKIE_KEYS,
  PLATFORM_REFRESH_COOKIE_TTL_SECONDS,
  expiredPlatformCookies,
  platformAccessCookie,
  platformCookieNames,
  platformMfaChallengeCookie,
  platformSessionCookies,
} from './platform-cookies';

describe('cookies du realm plateforme', () => {
  it('ont des noms distincts des cookies établissement (avec et sans __Host-)', () => {
    for (const secure of [false, true]) {
      const tenant = Object.values(cookieNames(secure));
      const platform = Object.values(platformCookieNames(secure));
      expect(platform.filter((name) => tenant.includes(name))).toEqual([]);
    }
    expect(platformCookieNames(true).access.startsWith('__Host-')).toBe(true);
    expect(platformCookieNames(false).access).toBe('ghmt_pat');
  });

  it('posent des cookies httpOnly, Path=/ ; refresh en Strict avec la durée de session plateforme', () => {
    const [access, refresh] = platformSessionCookies({ accessToken: 'a', refreshToken: 'p.r', expiresIn: 600 }, false);
    expect(access).toMatchObject({ name: 'ghmt_pat', value: 'a', options: { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 600, secure: false } });
    expect(refresh).toMatchObject({ name: 'ghmt_prt', value: 'p.r', options: { sameSite: 'strict', maxAge: PLATFORM_REFRESH_COOKIE_TTL_SECONDS } });
  });

  it('utilise une durée par défaut sans expiresIn et le préfixe __Host- en mode sécurisé', () => {
    const [access] = platformSessionCookies({ accessToken: 'a', refreshToken: 'r' }, true);
    expect(access?.name).toBe('__Host-ghmt_pat');
    expect(access?.options.secure).toBe(true);
    expect(access?.options.maxAge).toBeGreaterThan(0);
  });

  it('remplace le jeton d\'accès et conserve le défi MFA côté serveur seulement (Strict, 5 min)', () => {
    expect(platformAccessCookie('new', false, 300).options.maxAge).toBe(300);
    expect(platformMfaChallengeCookie('c'.repeat(20), false)).toMatchObject({ name: 'ghmt_pmfa', options: { sameSite: 'strict', httpOnly: true, maxAge: 300 } });
  });

  it('expire les cookies demandés', () => {
    const expired = expiredPlatformCookies(false, PLATFORM_COOKIE_KEYS);
    expect(expired.map((c) => c.name)).toEqual(['ghmt_pat', 'ghmt_prt', 'ghmt_pmfa']);
    expect(expired.every((c) => c.options.maxAge === 0 && c.value === '')).toBe(true);
  });
});
