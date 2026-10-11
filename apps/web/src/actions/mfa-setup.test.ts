import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { okEnvelope, problem } from '@/lib/api/test-helpers';

vi.mock('next/navigation', async () => (await import('./test-kit')).navigationMock());
vi.mock('next/cache', async () => (await import('./test-kit')).cacheMock());
vi.mock('next/headers', async () => (await import('./test-kit')).headersMock());

import { activateTotpAction, sendMfaEmailCodeAction, startTotpSetupAction } from './mfa-setup';
import { form, stubApi } from './test-kit';

const SETUP = { otpauthUrl: 'otpauth://totp/GHMT:awa?secret=JBSWY3DPEHPK3PXP&issuer=GHMT', secret: 'JBSWY3DPEHPK3PXP' };

beforeEach(() => {
  vi.stubEnv('API_URL', 'http://api.test/api/v1');
  vi.stubEnv('SESSION_COOKIE_SECURE', 'false');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('startTotpSetupAction (docs/11 D7)', () => {
  it('sur réseau de confiance : QR sans code, corps vide', async () => {
    const { calls } = stubApi(() => okEnvelope(SETUP));
    const state = await startTotpSetupAction();
    expect(state.ok).toBe(true);
    expect(state.extra).toMatchObject({ secret: 'JBSWY3DPEHPK3PXP' });
    expect(calls.find((c) => c.path === '/auth/mfa/totp/setup')?.body).toBeUndefined();
  });

  it('transmet le code reçu par e-mail dans le corps', async () => {
    const { calls } = stubApi(() => okEnvelope(SETUP));
    expect((await startTotpSetupAction('123456')).ok).toBe(true);
    expect(calls.find((c) => c.path === '/auth/mfa/totp/setup')?.body).toEqual({ emailCode: '123456' });
  });

  it('403 mfa_email_code_required : demande l\'étape e-mail, sans alerte d\'erreur', async () => {
    stubApi(() => problem(403, 'mfa_email_code_required'));
    const state = await startTotpSetupAction();
    expect(state.ok).toBe(false);
    expect(state.extra).toEqual({ emailCodeRequired: true });
    expect(state.message).toBeUndefined();
  });

  it('422 invalid_email_code : erreur sur le champ du code, étape e-mail conservée', async () => {
    stubApi(() => problem(422, 'invalid_email_code'));
    const state = await startTotpSetupAction('000000');
    expect(state.fieldErrors).toEqual({ emailCode: 'Le code reçu par e-mail est invalide ou expiré.' });
    expect(state.extra).toEqual({ emailCodeRequired: true });
  });

  it('code mal formé : refus local, aucun appel', async () => {
    const { calls } = stubApi(() => undefined);
    const state = await startTotpSetupAction('12ab');
    expect(state.fieldErrors?.emailCode).toBeTruthy();
    expect(state.extra).toEqual({ emailCodeRequired: true });
    expect(calls).toHaveLength(0);
  });

  it('409 mfa_already_enrolled et réponse inattendue', async () => {
    stubApi(() => problem(409, 'mfa_already_enrolled'));
    expect((await startTotpSetupAction()).message).toContain('déjà activée');
    stubApi(() => okEnvelope({}));
    expect((await startTotpSetupAction()).message).toContain('Réponse inattendue');
  });
});

describe('sendMfaEmailCodeAction', () => {
  it('POST /auth/mfa/totp/email-code et adresse masquée dans l\'état', async () => {
    const { calls } = stubApi(() => okEnvelope({ sent: true, emailMasked: 'a***@clinique.sn' }, {}, 202));
    const state = await sendMfaEmailCodeAction();
    expect(state.ok).toBe(true);
    expect(state.message).toBe('Un code à 6 chiffres vient d\'être envoyé à a***@clinique.sn.');
    expect(state.extra).toEqual({ emailMasked: 'a***@clinique.sn' });
    expect(calls.find((c) => c.path === '/auth/mfa/totp/email-code')?.method).toBe('POST');
  });

  it('adresse masquée absente : message sans adresse', async () => {
    stubApi(() => okEnvelope({ sent: true }, {}, 202));
    expect((await sendMfaEmailCodeAction()).message).toBe('Un code à 6 chiffres vient d\'être envoyé à l\'adresse de votre compte.');
  });

  it('422 email_code_not_required : réseau de confiance, on peut générer le QR sans code', async () => {
    stubApi(() => problem(422, 'email_code_not_required'));
    const state = await sendMfaEmailCodeAction();
    expect(state.ok).toBe(false);
    expect(state.extra).toEqual({ emailCodeNotRequired: true });
  });

  it('429 : message de limitation', async () => {
    stubApi(() => problem(429, 'too_many_requests'));
    expect((await sendMfaEmailCodeAction()).message).toContain('Trop de tentatives');
  });
});

describe('activateTotpAction (inchangé)', () => {
  it('refuse un code mal formé', async () => {
    const { calls } = stubApi(() => undefined);
    expect((await activateTotpAction({}, form({ code: '12' }))).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('active et renvoie les codes de secours', async () => {
    stubApi(() => okEnvelope({ accessToken: 'new', backupCodes: ['ABCDE23456'] }));
    const state = await activateTotpAction({}, form({ code: '123 456' }));
    expect(state).toMatchObject({ ok: true, extra: { backupCodes: ['ABCDE23456'] } });
  });
});
