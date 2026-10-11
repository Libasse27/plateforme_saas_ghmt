import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { okEnvelope, problem } from '@/lib/api/test-helpers';

vi.mock('next/navigation', async () => (await import('./test-kit')).navigationMock());
vi.mock('next/cache', async () => (await import('./test-kit')).cacheMock());
vi.mock('next/headers', async () => (await import('./test-kit')).headersMock());

import { resendSignupVerificationAction, verifySignupAction } from './signup-verification';
import { form, redirectOf, stubApi } from './test-kit';

const TOKEN = '0190a3b2-7c11-7a55-9e0f-3a1b2c3d4e5f.abcdefghijklmnopqrstuvwxyz0123456789_-ABCDEF';

beforeEach(() => {
  vi.stubEnv('API_URL', 'http://api.test/api/v1');
  vi.stubEnv('SESSION_COOKIE_SECURE', 'false');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('resendSignupVerificationAction (docs/11 §6.2)', () => {
  const RESEND = { tenantSlug: 'Clinique-Neuve', email: 'Awa@Clinique.sn' };

  it('POST /auth/signup/resend puis message unique', async () => {
    const { calls } = stubApi(() => okEnvelope({ accepted: true }, {}, 202));
    const state = await resendSignupVerificationAction({}, form(RESEND));
    expect(state).toMatchObject({ ok: true });
    expect(state.message).toContain('Si un compte en attente correspond');
    expect(calls.find((c) => c.path === '/auth/signup/resend')?.body).toEqual({ tenantSlug: 'clinique-neuve', email: 'awa@clinique.sn' });
  });

  it('même état pour une réponse 404 simulée', async () => {
    stubApi(() => okEnvelope({ accepted: true }, {}, 202));
    const ok = await resendSignupVerificationAction({}, form(RESEND));
    stubApi(() => problem(404, 'not_found'));
    expect(await resendSignupVerificationAction({}, form(RESEND))).toEqual(ok);
  });

  it('429 : message de limitation', async () => {
    stubApi(() => problem(429, 'too_many_requests'));
    const state = await resendSignupVerificationAction({}, form(RESEND));
    expect(state.ok).toBe(false);
    expect(state.message).toContain('Trop de tentatives');
  });

  it('validation locale', async () => {
    const { calls } = stubApi(() => undefined);
    expect((await resendSignupVerificationAction({}, form({ tenantSlug: '', email: 'x' }))).fieldErrors).toHaveProperty('email');
    expect(calls).toHaveLength(0);
  });
});

describe('verifySignupAction (docs/11 D1, §6.2)', () => {
  it('jeton dans le corps, puis redirection vers la connexion avec le code établissement', async () => {
    const { calls } = stubApi(() => okEnvelope({ tenantSlug: 'clinique-neuve' }));
    expect(await redirectOf(verifySignupAction({}, form({ token: TOKEN })))).toBe('/connexion?etablissement=clinique-neuve&confirme=1');
    const call = calls.find((c) => c.path === '/auth/signup/verify');
    expect(call?.method).toBe('POST');
    expect(call?.body).toEqual({ token: TOKEN });
    expect(call?.url).not.toContain('abcdefghijklmnop');
  });

  it('réponse sans code établissement valide : redirection sans paramètre d\'établissement', async () => {
    stubApi(() => okEnvelope({ tenantSlug: '../x' }));
    expect(await redirectOf(verifySignupAction({}, form({ token: TOKEN })))).toBe('/connexion?confirme=1');
  });

  it('410 : lien invalide, déjà utilisé ou expiré', async () => {
    stubApi(() => problem(410, 'verification_token_invalid'));
    const state = await verifySignupAction({}, form({ token: TOKEN }));
    expect(state.ok).toBe(false);
    expect(state.message).toContain('invalide, déjà utilisé ou expiré');
    expect(state.extra).toEqual({ linkInvalid: true });
  });

  it('jeton mal formé : aucun appel', async () => {
    const { calls } = stubApi(() => undefined);
    const state = await verifySignupAction({}, form({ token: 'x/../y' }));
    expect(state.extra).toEqual({ linkInvalid: true });
    expect(calls).toHaveLength(0);
  });
});
