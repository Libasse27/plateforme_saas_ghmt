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

import { clearMfaChallenge, clearSession, cookieTokenStore, readMfaChallenge, replaceAccessToken, storeMfaChallenge, storeSession } from './store';

beforeEach(() => {
  jar.clear();
  vi.unstubAllEnvs();
  vi.stubEnv('SESSION_COOKIE_SECURE', 'false');
});

describe('cookieTokenStore', () => {
  it('lit les jetons depuis les cookies', async () => {
    jar.set('ghmt_at', { value: 'a' });
    jar.set('ghmt_rt', { value: 'r' });
    expect(await cookieTokenStore({ persist: false }).read()).toEqual({ accessToken: 'a', refreshToken: 'r' });
  });

  it('est en lecture seule sans persist (pas de write ni clear)', () => {
    const store = cookieTokenStore({ persist: false });
    expect(store.write).toBeUndefined();
    expect(store.clear).toBeUndefined();
  });

  it('écrit puis efface la session quand persist est actif', async () => {
    const store = cookieTokenStore({ persist: true });
    await store.write?.({ accessToken: 'a2', refreshToken: 'r2', expiresIn: 600 });
    expect(jar.get('ghmt_at')?.value).toBe('a2');
    expect(jar.get('ghmt_rt')?.value).toBe('r2');
    await store.clear?.();
    expect(jar.get('ghmt_at')?.value).toBe('');
    expect(jar.get('ghmt_rt')?.value).toBe('');
  });
});

describe('fonctions de session', () => {
  it('stocke la session avec des cookies httpOnly', async () => {
    await storeSession({ accessToken: 'a', refreshToken: 'r' });
    expect(jar.get('ghmt_at')?.options).toMatchObject({ httpOnly: true, sameSite: 'lax' });
    expect(jar.get('ghmt_rt')?.options).toMatchObject({ httpOnly: true, sameSite: 'strict' });
  });

  it('utilise le préfixe __Host- quand Secure est actif', async () => {
    vi.stubEnv('SESSION_COOKIE_SECURE', 'true');
    await storeSession({ accessToken: 'a', refreshToken: 'r' });
    expect(jar.has('__Host-ghmt_at')).toBe(true);
    expect(jar.get('__Host-ghmt_at')?.options).toMatchObject({ secure: true });
  });

  it('remplace seulement le jeton d\'accès', async () => {
    jar.set('ghmt_rt', { value: 'keep' });
    await replaceAccessToken('new');
    expect(jar.get('ghmt_at')?.value).toBe('new');
    expect(jar.get('ghmt_rt')?.value).toBe('keep');
  });

  it('gère le défi MFA', async () => {
    await storeMfaChallenge('challenge-123');
    expect(await readMfaChallenge()).toBe('challenge-123');
    await clearMfaChallenge();
    expect(await readMfaChallenge()).toBe('');
  });

  it('clearSession vide tous les cookies de session', async () => {
    await storeSession({ accessToken: 'a', refreshToken: 'r' });
    await storeMfaChallenge('c');
    await clearSession();
    expect([...jar.values()].every((c) => c.value === '')).toBe(true);
  });
});
