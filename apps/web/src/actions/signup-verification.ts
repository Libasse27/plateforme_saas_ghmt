'use server';

import { redirect } from 'next/navigation';
import { isApiError } from '@/lib/api/errors';
import { describeApiError } from '@/lib/api/messages';
import { isOpaqueLinkToken, resendVerificationForm, safeTenantSlug } from '@/lib/domain/security-forms';
import { rec, str } from '@/lib/domain/raw';
import { formDataToFlat, publicValues, type FormState } from '@/lib/forms';
import { publicRequest } from '@/server/api';
import { acceptedWithoutOracle } from './account-links';
import { failureState, invalidState } from './helpers';

const RESEND_MESSAGE = 'Si un compte en attente correspond à ces informations, un nouvel e-mail de confirmation vient d\'être envoyé. Seul le dernier lien reçu fonctionne.';
const LINK_INVALID: FormState = { ok: false, message: describeApiError({ status: 410, code: 'verification_token_invalid' }), extra: { linkInvalid: true } };

/** Renvoi de l'e-mail de vérification (docs/11 §6.2) : réponse identique quel que soit le compte. */
export async function resendSignupVerificationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const form = resendVerificationForm(flat);
  if (!form.ok) return invalidState(form.errors, publicValues(flat));
  return acceptedWithoutOracle('/auth/signup/resend', form.data, RESEND_MESSAGE, publicValues(flat));
}

/** Confirmation explicite (clic sur le bouton, D1) : le jeton part dans le corps de la requête. Aucune session n'est ouverte. */
export async function verifySignupAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const token = formDataToFlat(formData).token ?? '';
  if (!isOpaqueLinkToken(token)) return LINK_INVALID;
  let tenantSlug: string | null = null;
  try {
    const { data } = await publicRequest('/auth/signup/verify', { method: 'POST', body: { token } });
    tenantSlug = safeTenantSlug(str(rec(data).tenantSlug));
  } catch (error) {
    if (isApiError(error) && error.status === 410) return LINK_INVALID;
    return failureState(error);
  }
  redirect(tenantSlug ? `/connexion?etablissement=${tenantSlug}&confirme=1` : '/connexion?confirme=1');
}
