'use server';

import { redirect } from 'next/navigation';
import { platformLoginSchema, platformMfaVerifySchema, platformTotpActivateSchema } from '@ghmt/shared';
import { isApiError } from '@/lib/api/errors';
import { parseTokenPair } from '@/lib/api/refresh';
import { PLATFORM_LOGIN_PATH, PLATFORM_MFA_PATH } from '@/lib/auth/platform-me';
import { backupCodesOf, buildTotpSetup } from '@/lib/domain/totp';
import { fieldErrorsFromZod, formDataToFlat, publicValues, safePlatformPath, type FormState } from '@/lib/forms';
import {
  clearPlatformMfaChallenge,
  clearPlatformSession,
  readPlatformMfaChallenge,
  readPlatformRefreshToken,
  replacePlatformAccessToken,
  storePlatformMfaChallenge,
  storePlatformSession,
} from '@/lib/session/platform-store';
import { platformActionApi, platformPublicRequest } from '@/server/platform-api';
import { failureState, invalidState } from './helpers';

const MFA_CODE_SEPARATORS = /[\s-]/g;
const UNEXPECTED = 'Réponse inattendue du serveur. Veuillez réessayer.';
const INVALID_LOGIN = 'E-mail ou mot de passe invalide.';
const INVALID_CODE = 'Code invalide ou expiré.';
const ENROLMENT_BY_OPERATIONS = 'L\'enrôlement du second facteur est réalisé par l\'équipe d\'exploitation : contactez-la pour activer ce compte.';

/** Enrôlement web retiré côté API (403/404) : message clair plutôt qu'une erreur générique. */
function enrolmentFailure(error: unknown): FormState {
  if (isApiError(error) && (error.status === 403 || error.status === 404)) return { ok: false, message: ENROLMENT_BY_OPERATIONS };
  return failureState(error);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Connexion plateforme : toujours une étape MFA. Compte enrôlé => défi (gardé dans un cookie httpOnly) ;
 * compte sans TOTP => session limitée (mfa=false) et enrôlement obligatoire.
 */
export async function platformLoginAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const next = safePlatformPath(flat.next);
  const input = { email: (flat.email ?? '').trim(), password: flat.password ?? '' };
  const values = publicValues({ email: input.email });

  const parsed = platformLoginSchema.safeParse(input);
  if (!parsed.success) return invalidState(fieldErrorsFromZod(parsed.error), values);

  let data: Record<string, unknown>;
  try {
    data = asRecord((await platformPublicRequest('/platform/auth/login', { method: 'POST', body: parsed.data })).data);
  } catch (error) {
    if (isApiError(error) && error.status === 401) return { ok: false, message: INVALID_LOGIN, values };
    return failureState(error, values);
  }

  if (typeof data.challengeId === 'string' && data.challengeId.length > 0) {
    await storePlatformMfaChallenge(data.challengeId);
    redirect(`${PLATFORM_LOGIN_PATH}/mfa?next=${encodeURIComponent(next)}`);
  }
  const pair = parseTokenPair(data);
  if (pair) {
    await storePlatformSession(pair);
    redirect(PLATFORM_MFA_PATH);
  }
  return { ok: false, message: UNEXPECTED, values };
}

export async function platformMfaVerifyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const next = safePlatformPath(flat.next);
  const challengeId = await readPlatformMfaChallenge();
  if (!challengeId) redirect(`${PLATFORM_LOGIN_PATH}?session=expiree`);

  const code = (flat.code ?? '').replace(MFA_CODE_SEPARATORS, '').toUpperCase();
  const parsed = platformMfaVerifySchema.safeParse({ challengeId, code });
  if (!parsed.success) {
    return { ok: false, message: 'Saisissez le code à 6 chiffres de votre application, ou un code de secours.', fieldErrors: { code: 'Code invalide.' } };
  }

  try {
    const { data } = await platformPublicRequest('/platform/auth/mfa/verify', { method: 'POST', body: parsed.data });
    const pair = parseTokenPair(data);
    if (!pair) return { ok: false, message: UNEXPECTED };
    await storePlatformSession(pair);
  } catch (error) {
    if (isApiError(error) && error.status === 401) return { ok: false, message: INVALID_CODE, fieldErrors: { code: INVALID_CODE } };
    return failureState(error);
  }
  await clearPlatformMfaChallenge();
  redirect(next);
}

/** Démarre l'enrôlement TOTP du compte plateforme (session sans MFA). */
export async function startPlatformTotpSetupAction(): Promise<FormState> {
  try {
    const setup = await buildTotpSetup((await platformActionApi('/platform/auth/mfa/totp/setup', { method: 'POST' })).data);
    if (!setup) return { ok: false, message: UNEXPECTED };
    return { ok: true, extra: { qrDataUrl: setup.qrDataUrl, secret: setup.secret } };
  } catch (error) {
    return enrolmentFailure(error);
  }
}

export async function activatePlatformTotpAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const code = (formDataToFlat(formData).code ?? '').replace(/\s/g, '');
  const parsed = platformTotpActivateSchema.safeParse({ code });
  if (!parsed.success) {
    return { ok: false, message: 'Saisissez le code à 6 chiffres affiché dans votre application.', fieldErrors: fieldErrorsFromZod(parsed.error) };
  }
  try {
    const { data } = await platformActionApi<unknown>('/platform/auth/mfa/totp/activate', { method: 'POST', body: parsed.data });
    const { accessToken, expiresIn } = asRecord(data);
    if (typeof accessToken === 'string' && accessToken.length > 0) {
      await replacePlatformAccessToken(accessToken, typeof expiresIn === 'number' ? expiresIn : undefined);
    }
    return { ok: true, message: 'Authentification à deux facteurs activée.', extra: { backupCodes: backupCodesOf(data) } };
  } catch (error) {
    if (isApiError(error) && error.code === 'invalid_code') return { ok: false, message: INVALID_CODE, fieldErrors: { code: INVALID_CODE } };
    return enrolmentFailure(error);
  }
}

/** Déconnexion plateforme : révocation « au mieux » du refresh token, purge systématique des cookies plateforme. */
export async function platformLogoutAction(): Promise<void> {
  const refreshToken = await readPlatformRefreshToken();
  if (refreshToken) {
    try {
      await platformPublicRequest('/platform/auth/logout', { method: 'POST', body: { refreshToken } });
    } catch (error) {
      if (!isApiError(error)) throw error;
    }
  }
  await clearPlatformSession();
  redirect(PLATFORM_LOGIN_PATH);
}
