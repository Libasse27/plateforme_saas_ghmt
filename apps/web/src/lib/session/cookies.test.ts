import { describe, expect, it } from 'vitest';
import { accessCookie, cookieNames, expiredCookies, mfaChallengeCookie, sessionCookies } from './cookies';

describe('cookieNames', () => {
  it('ajoute le préfixe __Host- en mode sécurisé', () => {
    expect(cookieNames(true).access).toBe('__Host-ghmt_at');
    expect(cookieNames(false).access).toBe('ghmt_at');
    expect(cookieNames(true).mfaChallenge).toBe('__Host-ghmt_mfa');
  });
});

describe('sessionCookies', () => {
  const pair = { accessToken: 'a', refreshToken: 'r', expiresIn: 900 };

  it('pose des cookies httpOnly, Lax pour l\'accès et Strict pour le refresh', () => {
    const [access, refresh] = sessionCookies(pair, true);
    expect(access).toMatchObject({ name: '__Host-ghmt_at', value: 'a', options: { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 900 } });
    expect(refresh).toMatchObject({ name: '__Host-ghmt_rt', value: 'r', options: { httpOnly: true, secure: true, sameSite: 'strict', path: '/' } });
  });

  it('utilise une durée par défaut sans expiresIn et ne pose pas Secure en développement', () => {
    const [access] = sessionCookies({ accessToken: 'a', refreshToken: 'r' }, false);
    expect(access?.options.maxAge).toBe(900);
    expect(access?.options.secure).toBe(false);
  });
});

describe('autres cookies', () => {
  it('accessCookie remplace seulement le jeton d\'accès', () => {
    expect(accessCookie('x', false, 60.9).options.maxAge).toBe(60);
    expect(accessCookie('x', false).options.maxAge).toBe(900);
  });
  it('le défi MFA expire en 5 minutes', () => {
    expect(mfaChallengeCookie('c', true).options.maxAge).toBe(300);
  });
  it('expiredCookies vide la valeur et met maxAge à 0', () => {
    const cookies = expiredCookies(false, ['access', 'refresh']);
    expect(cookies.map((c) => c.name)).toEqual(['ghmt_at', 'ghmt_rt']);
    expect(cookies.every((c) => c.value === '' && c.options.maxAge === 0)).toBe(true);
  });
});
