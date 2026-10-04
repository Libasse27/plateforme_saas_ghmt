'use server';

import { redirect } from 'next/navigation';
import { loginSchema, mfaVerifySchema, signupTenantSchema } from '@ghmt/shared';
import { parseTokenPair } from '@/lib/api/refresh';
import { isApiError } from '@/lib/api/errors';
import { fieldErrorsFromZod, formDataToFlat, nestFlat, publicValues, safeNextPath, type FormState } from '@/lib/forms';
import {
  clearMfaChallenge,
  clearSession,
  readMfaChallenge,
  readRefreshToken,
  storeMfaChallenge,
  storeSession,
} from '@/lib/session/store';
import { publicRequest } from '@/server/api';
import { failureState, invalidState } from './helpers';

const MFA_CODE_SEPARATORS = /[\s-]/g;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

export async function loginAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const next = safeNextPath(flat.next);
  const input = { tenantSlug: (flat.tenantSlug ?? '').trim().toLowerCase(), email: (flat.email ?? '').trim(), password: flat.password ?? '' };
  const values = publicValues({ tenantSlug: input.tenantSlug, email: input.email });

  const parsed = loginSchema.safeParse(input);
  if (!parsed.success) return invalidState(fieldErrorsFromZod(parsed.error), values);

  let data: Record<string, unknown>;
  try {
    data = asRecord((await publicRequest('/auth/login', { method: 'POST', body: parsed.data })).data);
  } catch (error) {
    return failureState(error, values);
  }

  const pair = parseTokenPair(data);
  if (pair) {
    await storeSession(pair);
    redirect(next);
  }
  if (typeof data.challengeId === 'string' && data.challengeId.length > 0) {
    await storeMfaChallenge(data.challengeId);
    redirect(`/connexion/mfa?next=${encodeURIComponent(next)}`);
  }
  return { ok: false, message: 'Réponse inattendue du serveur. Veuillez réessayer.', values };
}

export async function mfaVerifyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const next = safeNextPath(flat.next);
  const challengeId = await readMfaChallenge();
  if (!challengeId) redirect('/connexion?session=expiree');

  const code = (flat.code ?? '').replace(MFA_CODE_SEPARATORS, '').toUpperCase();
  const parsed = mfaVerifySchema.safeParse({ challengeId, code });
  if (!parsed.success) {
    return { ok: false, message: 'Saisissez le code à 6 chiffres de votre application, ou un code de secours.', fieldErrors: { code: 'Code invalide.' } };
  }

  try {
    const { data } = await publicRequest('/auth/mfa/verify', { method: 'POST', body: parsed.data });
    const pair = parseTokenPair(data);
    if (!pair) return { ok: false, message: 'Réponse inattendue du serveur. Veuillez réessayer.' };
    await storeSession(pair);
  } catch (error) {
    if (isApiError(error) && error.status === 401) {
      return { ok: false, message: 'Code invalide ou expiré.', fieldErrors: { code: 'Code invalide ou expiré.' } };
    }
    return failureState(error);
  }
  await clearMfaChallenge();
  redirect(next);
}

export async function signupAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const values = publicValues(flat);
  const nested = nestFlat(flat);

  const parsed = signupTenantSchema.safeParse(nested);
  const errors = parsed.success ? {} : fieldErrorsFromZod(parsed.error);
  if (flat['admin.password'] !== flat['admin.confirmPassword']) {
    errors['admin.confirmPassword'] = 'Les mots de passe ne correspondent pas.';
  }
  if (!parsed.success || Object.keys(errors).length > 0) return invalidState(errors, values);

  try {
    await publicRequest('/auth/signup', { method: 'POST', body: parsed.data });
  } catch (error) {
    return failureState(error, values);
  }
  redirect(`/connexion?etablissement=${encodeURIComponent(parsed.data.establishment.slug)}&inscrit=1`);
}

/**
 * Déconnexion (C8) : le refresh token est envoyé à l'API (route publique) pour révoquer la session.
 * La révocation est « au mieux », la session locale est toujours purgée.
 */
export async function logoutAction(): Promise<void> {
  const refreshToken = await readRefreshToken();
  if (refreshToken) {
    try {
      await publicRequest('/auth/logout', { method: 'POST', body: { refreshToken } });
    } catch (error) {
      if (!isApiError(error)) throw error;
    }
  }
  await clearSession();
  redirect('/connexion');
}
