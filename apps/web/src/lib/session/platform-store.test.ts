import { beforeEach, describe, expect, it, vi } from 'vitest';

const jar = new Map<string, { value: string; options?: unknown }>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)!.value } : undefined),
    set: (name: string, value: string, options?: unknown) => {
      jar.set(name, { value, options });
    },
  }),
}));

import {
  clearPlatformMfaChallenge,
  clearPlatformSession,
  platformTokenStore,
  readPlatformMfaChallenge,
  readPlatformRefreshToken,
  replacePlatformAccessToken,
  storePlatformMfaChallenge,
  storePlatformSession,
} from './platform-store';

beforeEach(() => {
  jar.clear();
  vi.unstubAllEnvs();
  vi.stubEnv('SESSION_COOKIE_SECURE', 'false');
});

describe('platformTokenStore', () => {
  it('lit uniquement les cookies plateforme, jamais ceux de l\'établissement', async () => {
    jar.set('ghmt_at', { value: 'tenant-a' });
    jar.set('ghmt_rt', { value: 'tenant-r' });
    expect(await platformTokenStore({ persist: false }).read()).toEqual({ accessToken: undefined, refreshToken: undefined });
    jar.set('ghmt_pat', { value: 'pa' });
    jar.set('ghmt_prt', { value: 'p.pr' });
    expect(await platformTokenStore({ persist: false }).read()).toEqual({ accessToken: 'pa', refreshToken: 'p.pr' });
  });

  it('est en lecture seule sans persist', () => {
    const store = platformTokenStore({ persist: false });
    expect(store.write).toBeUndefined();
    expect(store.clear).toBeUndefined();
  });

  it('écrit et efface la session plateforme sans toucher à la session établissement', async () => {
    jar.set('ghmt_at', { value: 'tenant-a' });
    const store = platformTokenStore({ persist: true });
    await store.write?.({ accessToken: 'a', refreshToken: 'p.r', expiresIn: 600 });
    expect(jar.get('ghmt_pat')?.value).toBe('a');
    expect(jar.get('ghmt_prt')?.options).toMatchObject({ httpOnly: true, sameSite: 'strict' });
    await store.clear?.();
    expect(jar.get('ghmt_pat')?.value).toBe('');
    expect(jar.get('ghmt_at')?.value).toBe('tenant-a');
  });
});

describe('fonctions de session plateforme', () => {
  it('stocke, remplace et efface', async () => {
    await storePlatformSession({ accessToken: 'a', refreshToken: 'p.r' });
    expect(await readPlatformRefreshToken()).toBe('p.r');
    await replacePlatformAccessToken('a2', 300);
    expect(jar.get('ghmt_pat')?.value).toBe('a2');
    expect(jar.get('ghmt_prt')?.value).toBe('p.r');
    await clearPlatformSession();
    expect(await readPlatformRefreshToken()).toBe('');
  });

  it('gère le défi MFA', async () => {
    await storePlatformMfaChallenge('challenge-123456789012');
    expect(await readPlatformMfaChallenge()).toBe('challenge-123456789012');
    await clearPlatformMfaChallenge();
    expect(await readPlatformMfaChallenge()).toBe('');
  });

  it('utilise le préfixe __Host- en mode sécurisé', async () => {
    vi.stubEnv('SESSION_COOKIE_SECURE', 'true');
    await storePlatformSession({ accessToken: 'a', refreshToken: 'p.r' });
    expect(jar.has('__Host-ghmt_pat')).toBe(true);
  });
});
