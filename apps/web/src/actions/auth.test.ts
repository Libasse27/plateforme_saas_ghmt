import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, okEnvelope, problem } from '@/lib/api/test-helpers';

vi.mock('next/navigation', async () => (await import('./test-kit')).navigationMock());
vi.mock('next/cache', async () => (await import('./test-kit')).cacheMock());
vi.mock('next/headers', async () => (await import('./test-kit')).headersMock());

import { loginAction, signupAction } from './auth';
import { form, redirectOf, stubApi } from './test-kit';

const LOGIN = { tenantSlug: 'clinique-a', email: 'awa@clinique.sn', password: 'un-mot-de-passe-long' };

beforeEach(() => {
  vi.stubEnv('API_URL', 'http://api.test/api/v1');
  vi.stubEnv('SESSION_COOKIE_SECURE', 'false');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('loginAction : délai progressif (docs/11 D3)', () => {
  it('429 login_delayed : message avec les secondes du détail et compte à rebours exposé', async () => {
    stubApi(() => problem(429, 'login_delayed', { details: { retryAfterSeconds: 30 } }));
    const state = await loginAction({}, form(LOGIN));
    expect(state.ok).toBe(false);
    expect(state.message).toBe('Trop de tentatives pour ce compte. Réessayez dans 30 secondes.');
    expect(state.extra).toEqual({ retryAfterSeconds: 30 });
    expect(state.values).toEqual({ tenantSlug: 'clinique-a', email: 'awa@clinique.sn' });
    expect(JSON.stringify(state)).not.toContain('un-mot-de-passe-long');
  });

  it('429 sans détail exploitable : message sans durée et aucun compte à rebours', async () => {
    stubApi(() => problem(429, 'login_delayed'));
    const state = await loginAction({}, form(LOGIN));
    expect(state.message).toContain('quelques instants');
    expect(state.extra?.retryAfterSeconds).toBeUndefined();
  });

  it('un simple 429 de limitation d\'IP reste un message générique, sans compte à rebours', async () => {
    stubApi(() => problem(429, 'too_many_requests'));
    const state = await loginAction({}, form(LOGIN));
    expect(state.message).toContain('Trop de tentatives');
    expect(state.extra).toBeUndefined();
  });
});

describe('loginAction : inscription non vérifiée (docs/11 D12)', () => {
  it('403 email_verification_required : message dédié et code établissement pour le lien de renvoi', async () => {
    stubApi(() => problem(403, 'email_verification_required'));
    const state = await loginAction({}, form(LOGIN));
    expect(state.message).toContain('Confirmez l\'adresse e-mail de l\'administrateur');
    expect(state.extra).toEqual({ verificationTenant: 'clinique-a' });
  });
});

describe('loginAction : comportements existants', () => {
  it('401 invalid_credentials : message d\'identifiants', async () => {
    stubApi(() => problem(401, 'invalid_credentials'));
    expect((await loginAction({}, form(LOGIN))).message).toContain('Identifiants invalides');
  });

  it('validation locale : aucun appel réseau', async () => {
    const { calls } = stubApi(() => undefined);
    const state = await loginAction({}, form({ ...LOGIN, email: 'nope' }));
    expect(state.fieldErrors?.email).toBeDefined();
    expect(calls).toHaveLength(0);
  });

  it('succès : redirige vers la page demandée (chemin interne seulement)', async () => {
    stubApi(() => okEnvelope({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 }));
    expect(await redirectOf(loginAction({}, form({ ...LOGIN, next: '/patients' })))).toBe('/patients');
    expect(await redirectOf(loginAction({}, form({ ...LOGIN, next: '//evil.test' })))).toBe('/');
  });

  it('défi MFA : redirige vers /connexion/mfa', async () => {
    stubApi(() => okEnvelope({ challengeId: 'c'.repeat(32) }));
    expect(await redirectOf(loginAction({}, form(LOGIN)))).toBe('/connexion/mfa?next=%2F');
  });

  it('réponse inattendue', async () => {
    stubApi(() => okEnvelope({}));
    expect((await loginAction({}, form(LOGIN))).message).toContain('Réponse inattendue');
  });

  it('panne réseau : message de service injoignable', async () => {
    stubApi(() => jsonResponse(503, {}));
    expect((await loginAction({}, form(LOGIN))).ok).toBe(false);
  });
});

describe('signupAction : vérification de l\'e-mail', () => {
  const SIGNUP = {
    'establishment.slug': 'clinique-neuve',
    'establishment.legalName': 'Clinique Neuve SARL',
    'establishment.establishmentType': 'hospital_n1',
    'establishment.countryCode': 'SN',
    'establishment.baseCurrency': 'XOF',
    'establishment.timezone': 'Africa/Dakar',
    'mainSite.code': 'PRINC',
    'mainSite.name': 'Site principal',
    'admin.fullName': 'Awa Diop',
    'admin.email': 'awa@clinique.sn',
    'admin.password': 'un-mot-de-passe-long',
    'admin.confirmPassword': 'un-mot-de-passe-long',
  };

  it('succès : redirige vers la page « vérifiez votre e-mail » avec le code établissement', async () => {
    stubApi(() => okEnvelope({ tenantId: 't', slug: 'clinique-neuve' }, {}, 201));
    expect(await redirectOf(signupAction({}, form(SIGNUP)))).toBe('/inscription/verifier?etablissement=clinique-neuve');
  });

  it('422 slug_reserved : erreur affichée sur le champ du code établissement', async () => {
    stubApi(() => problem(422, 'slug_reserved', { errors: [{ path: 'establishment.slug', code: 'slug_reserved', message: 'Ce code établissement est réservé.' }] }));
    const state = await signupAction({}, form(SIGNUP));
    expect(state.fieldErrors).toEqual({ 'establishment.slug': 'Ce code établissement est réservé.' });
    expect(state.message).toContain('réservé');
    expect(state.values?.['admin.password']).toBeUndefined();
  });
});
