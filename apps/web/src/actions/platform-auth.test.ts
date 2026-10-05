import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';

class Redirect extends Error {
  constructor(readonly url: string) {
    super(`REDIRECT:${url}`);
  }
}
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Redirect(url);
  },
}));

const publicRequest = vi.fn();
const actionApi = vi.fn();
vi.mock('@/server/platform-api', () => ({
  platformPublicRequest: (...args: unknown[]) => publicRequest(...args),
  platformActionApi: (...args: unknown[]) => actionApi(...args),
}));

const store = {
  storePlatformSession: vi.fn(),
  storePlatformMfaChallenge: vi.fn(),
  readPlatformMfaChallenge: vi.fn(),
  clearPlatformMfaChallenge: vi.fn(),
  readPlatformRefreshToken: vi.fn(),
  clearPlatformSession: vi.fn(),
  replacePlatformAccessToken: vi.fn(),
};
vi.mock('@/lib/session/platform-store', () => ({
  storePlatformSession: (...a: unknown[]) => store.storePlatformSession(...a),
  storePlatformMfaChallenge: (...a: unknown[]) => store.storePlatformMfaChallenge(...a),
  readPlatformMfaChallenge: () => store.readPlatformMfaChallenge(),
  clearPlatformMfaChallenge: () => store.clearPlatformMfaChallenge(),
  readPlatformRefreshToken: () => store.readPlatformRefreshToken(),
  clearPlatformSession: () => store.clearPlatformSession(),
  replacePlatformAccessToken: (...a: unknown[]) => store.replacePlatformAccessToken(...a),
}));

import {
  activatePlatformTotpAction,
  platformLoginAction,
  platformLogoutAction,
  platformMfaVerifyAction,
  startPlatformTotpSetupAction,
} from './platform-auth';

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

async function redirectOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Redirect) return error.url;
    throw error;
  }
  throw new Error('aucune redirection');
}

const CHALLENGE = 'c'.repeat(32);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('platformLoginAction', () => {
  it('rejette un e-mail ou un mot de passe manquant sans appeler l\'API', async () => {
    const state = await platformLoginAction({}, form({ email: 'pas-un-email', password: '' }));
    expect(state.ok).toBe(false);
    expect(state.fieldErrors?.email).toBeDefined();
    expect(publicRequest).not.toHaveBeenCalled();
  });

  it('compte enrôlé : conserve le défi MFA côté serveur et redirige vers la vérification', async () => {
    publicRequest.mockResolvedValue({ data: { mfaRequired: true, challengeId: CHALLENGE, methods: ['totp', 'backup_code'] } });
    const url = await redirectOf(platformLoginAction({}, form({ email: 'root@ghmt.test', password: 'secret', next: '/plateforme/factures' })));
    expect(url).toBe('/plateforme/connexion/mfa?next=%2Fplateforme%2Ffactures');
    expect(store.storePlatformMfaChallenge).toHaveBeenCalledWith(CHALLENGE);
    expect(store.storePlatformSession).not.toHaveBeenCalled();
    expect(publicRequest).toHaveBeenCalledWith('/platform/auth/login', { method: 'POST', body: { email: 'root@ghmt.test', password: 'secret' } });
  });

  it('compte sans TOTP : stocke la session limitée (mfa=false) et impose l\'enrôlement', async () => {
    publicRequest.mockResolvedValue({ data: { accessToken: 'a', refreshToken: 'p.refresh-token-1', expiresIn: 900, mfaEnrolled: false, mfaRequired: true } });
    const url = await redirectOf(platformLoginAction({}, form({ email: 'root@ghmt.test', password: 'secret' })));
    expect(url).toBe('/plateforme/securite/mfa');
    expect(store.storePlatformSession).toHaveBeenCalledWith({ accessToken: 'a', refreshToken: 'p.refresh-token-1', expiresIn: 900 });
  });

  it('compte sans MFA enrôlée : 403 mfa_enrollment_required_cli expliqué', async () => {
    publicRequest.mockRejectedValue(new ApiError({ status: 403, code: 'mfa_enrollment_required_cli' }));
    const state = await platformLoginAction({}, form({ email: 'root@ghmt.test', password: 'secret' }));
    expect(state.ok).toBe(false);
    expect(state.message).toBe('Ce compte doit d\'abord être activé par l\'équipe d\'exploitation (enrôlement du second facteur).');
  });

  it('identifiants invalides : message neutre en français, e-mail conservé, mot de passe jamais renvoyé', async () => {
    publicRequest.mockRejectedValue(new ApiError({ status: 401, code: 'invalid_credentials' }));
    const state = await platformLoginAction({}, form({ email: 'root@ghmt.test', password: 'mauvais' }));
    expect(state.ok).toBe(false);
    expect(state.message).toBe('E-mail ou mot de passe invalide.');
    expect(state.values).toEqual({ email: 'root@ghmt.test' });
  });

  it('réponse inattendue : message d\'erreur', async () => {
    publicRequest.mockResolvedValue({ data: {} });
    const state = await platformLoginAction({}, form({ email: 'root@ghmt.test', password: 'x' }));
    expect(state.message).toContain('inattendue');
  });

  it('relance les erreurs inattendues', async () => {
    publicRequest.mockRejectedValue(new Error('bug'));
    await expect(platformLoginAction({}, form({ email: 'root@ghmt.test', password: 'x' }))).rejects.toThrow('bug');
  });
});

describe('platformMfaVerifyAction', () => {
  it('renvoie vers la connexion sans défi MFA', async () => {
    store.readPlatformMfaChallenge.mockResolvedValue(undefined);
    expect(await redirectOf(platformMfaVerifyAction({}, form({ code: '123456' })))).toBe('/plateforme/connexion?session=expiree');
  });

  it('valide un code TOTP (espaces ignorés), stocke la session, purge le défi et redirige vers un chemin plateforme', async () => {
    store.readPlatformMfaChallenge.mockResolvedValue(CHALLENGE);
    publicRequest.mockResolvedValue({ data: { accessToken: 'a', refreshToken: 'p.r-1234567890123456' } });
    const url = await redirectOf(platformMfaVerifyAction({}, form({ code: '123 456', next: '/plateforme/plans' })));
    expect(url).toBe('/plateforme/plans');
    expect(publicRequest).toHaveBeenCalledWith('/platform/auth/mfa/verify', { method: 'POST', body: { challengeId: CHALLENGE, code: '123456' } });
    expect(store.storePlatformSession).toHaveBeenCalled();
    expect(store.clearPlatformMfaChallenge).toHaveBeenCalled();
  });

  it('accepte un code de secours en minuscules', async () => {
    store.readPlatformMfaChallenge.mockResolvedValue(CHALLENGE);
    publicRequest.mockResolvedValue({ data: { accessToken: 'a', refreshToken: 'p.r-1234567890123456' } });
    await redirectOf(platformMfaVerifyAction({}, form({ code: 'abcde-23456' })));
    expect(publicRequest.mock.calls[0]?.[1]).toMatchObject({ body: { code: 'ABCDE23456' } });
  });

  it('une redirection ouverte est neutralisée (retour au tableau de bord plateforme)', async () => {
    store.readPlatformMfaChallenge.mockResolvedValue(CHALLENGE);
    publicRequest.mockResolvedValue({ data: { accessToken: 'a', refreshToken: 'p.r-1234567890123456' } });
    expect(await redirectOf(platformMfaVerifyAction({}, form({ code: '123456', next: '//evil.test' })))).toBe('/plateforme');
    publicRequest.mockResolvedValue({ data: { accessToken: 'a', refreshToken: 'p.r-1234567890123456' } });
    expect(await redirectOf(platformMfaVerifyAction({}, form({ code: '123456', next: '/patients' })))).toBe('/plateforme');
  });

  it('code mal formé : erreur de champ sans appel API', async () => {
    store.readPlatformMfaChallenge.mockResolvedValue(CHALLENGE);
    const state = await platformMfaVerifyAction({}, form({ code: '12' }));
    expect(state.ok).toBe(false);
    expect(state.fieldErrors?.code).toBeDefined();
    expect(publicRequest).not.toHaveBeenCalled();
  });

  it('401 : code invalide ou expiré', async () => {
    store.readPlatformMfaChallenge.mockResolvedValue(CHALLENGE);
    publicRequest.mockRejectedValue(new ApiError({ status: 401, code: 'invalid_mfa_code' }));
    const state = await platformMfaVerifyAction({}, form({ code: '123456' }));
    expect(state.message).toBe('Code invalide ou expiré.');
    expect(store.storePlatformSession).not.toHaveBeenCalled();
  });

  it('réponse sans jetons : erreur', async () => {
    store.readPlatformMfaChallenge.mockResolvedValue(CHALLENGE);
    publicRequest.mockResolvedValue({ data: {} });
    expect((await platformMfaVerifyAction({}, form({ code: '123456' }))).message).toContain('inattendue');
  });

  it('autre erreur API : message français', async () => {
    store.readPlatformMfaChallenge.mockResolvedValue(CHALLENGE);
    publicRequest.mockRejectedValue(new ApiError({ status: 429, code: 'throttled' }));
    expect((await platformMfaVerifyAction({}, form({ code: '123456' }))).message).toContain('Trop de tentatives');
  });
});

describe('enrôlement TOTP plateforme', () => {
  it('setup : renvoie le QR code et la clé', async () => {
    actionApi.mockResolvedValue({ data: { otpauthUrl: 'otpauth://totp/GHMT:root?secret=JBSWY3DPEHPK3PXP', secret: 'JBSWY3DPEHPK3PXP' } });
    const state = await startPlatformTotpSetupAction();
    expect(actionApi).toHaveBeenCalledWith('/platform/auth/mfa/totp/setup', { method: 'POST' });
    expect(state.ok).toBe(true);
    expect(state.extra?.secret).toBe('JBSWY3DPEHPK3PXP');
  });

  it('setup : réponse inattendue ou erreur API', async () => {
    actionApi.mockResolvedValueOnce({ data: {} });
    expect((await startPlatformTotpSetupAction()).ok).toBe(false);
    actionApi.mockRejectedValueOnce(new ApiError({ status: 403, code: 'forbidden' }));
    expect((await startPlatformTotpSetupAction()).message).toContain('équipe d\'exploitation');
    actionApi.mockRejectedValueOnce(new ApiError({ status: 404, code: 'not_found' }));
    expect((await startPlatformTotpSetupAction()).message).toContain('équipe d\'exploitation');
    actionApi.mockRejectedValueOnce(new ApiError({ status: 403, code: 'forbidden' }));
    expect((await activatePlatformTotpAction({}, form({ code: '123456' }))).message).toContain('équipe d\'exploitation');
  });

  it('activate : remplace le jeton d\'accès et renvoie les codes de secours une fois', async () => {
    actionApi.mockResolvedValue({ data: { accessToken: 'new-a', expiresIn: 900, backupCodes: ['ABCDE23456'] } });
    const state = await activatePlatformTotpAction({}, form({ code: '123 456' }));
    expect(actionApi).toHaveBeenCalledWith('/platform/auth/mfa/totp/activate', { method: 'POST', body: { code: '123456' } });
    expect(store.replacePlatformAccessToken).toHaveBeenCalledWith('new-a', 900);
    expect(state).toMatchObject({ ok: true, extra: { backupCodes: ['ABCDE23456'] } });
  });

  it('activate : code mal formé ou refusé', async () => {
    expect((await activatePlatformTotpAction({}, form({ code: 'abc' }))).fieldErrors?.code).toBeDefined();
    actionApi.mockRejectedValue(new ApiError({ status: 422, code: 'invalid_code' }));
    const refused = await activatePlatformTotpAction({}, form({ code: '123456' }));
    expect(refused.message).toBe('Code invalide ou expiré.');
    expect(refused.fieldErrors?.code).toBeDefined();
    actionApi.mockRejectedValue(new ApiError({ status: 422, code: 'mfa_not_pending' }));
    expect((await activatePlatformTotpAction({}, form({ code: '123456' }))).message).toContain('enrôlement');
  });

  it('activate : sans jeton dans la réponse, aucune écriture de cookie', async () => {
    actionApi.mockResolvedValue({ data: { backupCodes: [] } });
    await activatePlatformTotpAction({}, form({ code: '123456' }));
    expect(store.replacePlatformAccessToken).not.toHaveBeenCalled();
  });
});

describe('platformLogoutAction', () => {
  it('révoque la session côté API puis purge les cookies plateforme', async () => {
    store.readPlatformRefreshToken.mockResolvedValue('p.refresh-token-1234');
    publicRequest.mockResolvedValue({ data: null });
    expect(await redirectOf(platformLogoutAction())).toBe('/plateforme/connexion');
    expect(publicRequest).toHaveBeenCalledWith('/platform/auth/logout', { method: 'POST', body: { refreshToken: 'p.refresh-token-1234' } });
    expect(store.clearPlatformSession).toHaveBeenCalled();
  });

  it('purge même si la révocation échoue (erreur API) et sans refresh token', async () => {
    store.readPlatformRefreshToken.mockResolvedValue('p.refresh-token-1234');
    publicRequest.mockRejectedValue(new ApiError({ status: 0, code: 'network_error' }));
    await redirectOf(platformLogoutAction());
    expect(store.clearPlatformSession).toHaveBeenCalledTimes(1);
    store.readPlatformRefreshToken.mockResolvedValue(undefined);
    publicRequest.mockClear();
    await redirectOf(platformLogoutAction());
    expect(publicRequest).not.toHaveBeenCalled();
  });
});
