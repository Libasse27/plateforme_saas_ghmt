import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { okEnvelope, problem } from '@/lib/api/test-helpers';

vi.mock('next/navigation', async () => (await import('./test-kit')).navigationMock());
vi.mock('next/cache', async () => (await import('./test-kit')).cacheMock());
vi.mock('next/headers', async () => (await import('./test-kit')).headersMock());

import { forgotPasswordAction, resetPasswordAction } from './password-reset';
import { form, redirectOf, stubApi } from './test-kit';

const TOKEN = '0190a3b2-7c11-7a55-9e0f-3a1b2c3d4e5f.abcdefghijklmnopqrstuvwxyz0123456789_-ABCDEF';
const PASSWORD = 'un-nouveau-mot-de-passe';

beforeEach(() => {
  vi.stubEnv('API_URL', 'http://api.test/api/v1');
  vi.stubEnv('SESSION_COOKIE_SECURE', 'false');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('forgotPasswordAction (docs/11 D8)', () => {
  const FORGOT = { tenantSlug: ' Clinique-A ', email: ' Awa@Clinique.sn ' };

  it('POST /auth/password/forgot avec le code et l\'e-mail normalisés, puis message unique', async () => {
    const { calls } = stubApi(() => okEnvelope({ accepted: true }, {}, 202));
    const state = await forgotPasswordAction({}, form(FORGOT));
    expect(state).toMatchObject({ ok: true, message: 'Si un compte correspond à ces informations, un e-mail vient d\'être envoyé.' });
    const call = calls.find((c) => c.path === '/auth/password/forgot');
    expect(call?.method).toBe('POST');
    expect(call?.body).toEqual({ tenantSlug: 'clinique-a', email: 'awa@clinique.sn' });
    expect(call?.authorization).toBeUndefined();
  });

  it('même message quand l\'API répond 404 (aucun oracle sur l\'existence du compte)', async () => {
    const ok = await (async () => {
      stubApi(() => okEnvelope({ accepted: true }, {}, 202));
      return forgotPasswordAction({}, form(FORGOT));
    })();
    stubApi(() => problem(404, 'not_found'));
    const notFound = await forgotPasswordAction({}, form(FORGOT));
    expect(notFound).toEqual(ok);
  });

  it('429 : message de limitation, sans prétendre qu\'un e-mail est parti', async () => {
    stubApi(() => problem(429, 'too_many_requests'));
    const state = await forgotPasswordAction({}, form(FORGOT));
    expect(state.ok).toBe(false);
    expect(state.message).toContain('Trop de tentatives');
  });

  it('validation locale : aucun appel', async () => {
    const { calls } = stubApi(() => undefined);
    const state = await forgotPasswordAction({}, form({ tenantSlug: 'A', email: 'nope' }));
    expect(state.fieldErrors).toHaveProperty('email');
    expect(state.fieldErrors).toHaveProperty('tenantSlug');
    expect(calls).toHaveLength(0);
  });
});

describe('resetPasswordAction (docs/11 D8, §5.1)', () => {
  const RESET = { token: TOKEN, tenantSlug: 'clinique-a', newPassword: PASSWORD, confirmPassword: PASSWORD };

  it('envoie le jeton dans le CORPS (jamais dans l\'URL) puis redirige vers la connexion', async () => {
    const { calls } = stubApi(() => new Response(null, { status: 204 }));
    expect(await redirectOf(resetPasswordAction({}, form(RESET)))).toBe('/connexion?etablissement=clinique-a&reinitialise=1');
    const call = calls.find((c) => c.path === '/auth/password/reset');
    expect(call?.method).toBe('POST');
    expect(call?.url).not.toContain(TOKEN);
    expect(call?.url).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(call?.body).toEqual({ token: TOKEN, newPassword: PASSWORD });
  });

  it('transmet le code du second facteur quand il est saisi (espaces retirés)', async () => {
    const { calls } = stubApi(() => new Response(null, { status: 204 }));
    await redirectOf(resetPasswordAction({}, form({ ...RESET, mfaCode: '123 456' })));
    expect(calls.find((c) => c.path === '/auth/password/reset')?.body).toEqual({ token: TOKEN, newPassword: PASSWORD, mfaCode: '123456' });
  });

  it('ne reprend dans l\'URL de connexion qu\'un code établissement valide', async () => {
    stubApi(() => new Response(null, { status: 204 }));
    expect(await redirectOf(resetPasswordAction({}, form({ ...RESET, tenantSlug: 'x/../y' })))).toBe('/connexion?reinitialise=1');
    expect(await redirectOf(resetPasswordAction({}, form({ ...RESET, tenantSlug: '' })))).toBe('/connexion?reinitialise=1');
  });

  it('410 reset_token_invalid : lien invalide, avec marque pour proposer une nouvelle demande', async () => {
    stubApi(() => problem(410, 'reset_token_invalid'));
    const state = await resetPasswordAction({}, form(RESET));
    expect(state.ok).toBe(false);
    expect(state.message).toContain('invalide ou a expiré');
    expect(state.extra).toEqual({ linkInvalid: true });
  });

  it('422 mfa_code_required : fait apparaître le champ du code, sans effacer l\'erreur du champ', async () => {
    stubApi(() => problem(422, 'mfa_code_required', { errors: [{ path: 'mfaCode', code: 'mfa_code_required', message: 'Code requis' }] }));
    const state = await resetPasswordAction({}, form(RESET));
    expect(state.ok).toBe(false);
    expect(state.extra).toEqual({ mfaRequired: true });
    expect(state.fieldErrors?.mfaCode).toBeTruthy();
  });

  it('422 invalid_code : erreur sur le champ du code', async () => {
    stubApi(() => problem(422, 'invalid_code'));
    const state = await resetPasswordAction({}, form({ ...RESET, mfaCode: '000000' }));
    expect(state.fieldErrors?.mfaCode).toBe('Code invalide ou expiré.');
    expect(state.extra).toEqual({ mfaRequired: true });
  });

  it('validation locale : confirmation différente, jeton mal formé, aucun appel', async () => {
    const { calls } = stubApi(() => undefined);
    const mismatch = await resetPasswordAction({}, form({ ...RESET, confirmPassword: 'autre-mot-de-passe-long' }));
    expect(mismatch.fieldErrors?.confirmPassword).toContain('ne correspondent pas');
    const bad = await resetPasswordAction({}, form({ ...RESET, token: 'jeton/../x' }));
    expect(bad.ok).toBe(false);
    expect(bad.extra).toEqual({ linkInvalid: true });
    expect(calls).toHaveLength(0);
  });

  it('ne renvoie jamais de mot de passe ni de jeton dans l\'état du formulaire', async () => {
    stubApi(() => problem(422, 'validation_failed'));
    const state = await resetPasswordAction({}, form(RESET));
    const dump = JSON.stringify(state);
    expect(dump).not.toContain(PASSWORD);
    expect(dump).not.toContain(TOKEN);
  });
});
