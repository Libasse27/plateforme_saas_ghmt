'use server';

import { redirect } from 'next/navigation';
import { isApiError } from '@/lib/api/errors';
import { describeApiError } from '@/lib/api/messages';
import { forgotPasswordForm, resetPasswordForm, safeTenantSlug } from '@/lib/domain/security-forms';
import { formDataToFlat, publicValues, type FormState } from '@/lib/forms';
import { publicRequest } from '@/server/api';
import { acceptedWithoutOracle } from './account-links';
import { failureState, invalidState } from './helpers';

const FORGOT_MESSAGE = 'Si un compte correspond à ces informations, un e-mail vient d\'être envoyé.';
const LOGIN_AFTER_RESET = '/connexion?reinitialise=1';
const LINK_INVALID: FormState = { ok: false, message: describeApiError({ status: 410, code: 'reset_token_invalid' }), extra: { linkInvalid: true } };

/** Mot de passe oublié (docs/11 D8) : la même réponse quel que soit le compte, aucune information sur son existence. */
export async function forgotPasswordAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const form = forgotPasswordForm(flat);
  if (!form.ok) return invalidState(form.errors, publicValues(flat));
  return acceptedWithoutOracle('/auth/password/forgot', form.data, FORGOT_MESSAGE, publicValues(flat));
}

/**
 * Réinitialisation : le jeton voyage dans le corps de la requête (D1), jamais dans une URL d'API.
 * Aucune connexion automatique : retour à la page de connexion.
 */
export async function resetPasswordAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const form = resetPasswordForm(flat);
  if (!form.ok) return form.errors.token ? LINK_INVALID : invalidState(form.errors, {});

  try {
    await publicRequest('/auth/password/reset', { method: 'POST', body: form.data });
  } catch (error) {
    if (!isApiError(error)) throw error;
    if (error.status === 410) return LINK_INVALID;
    if (error.code === 'mfa_code_required' || error.code === 'invalid_code') {
      const message = describeApiError(error);
      return { ok: false, message, fieldErrors: { mfaCode: message }, extra: { mfaRequired: true } };
    }
    return failureState(error);
  }
  const tenantSlug = safeTenantSlug(flat.tenantSlug);
  redirect(tenantSlug ? `/connexion?etablissement=${tenantSlug}&reinitialise=1` : LOGIN_AFTER_RESET);
}
