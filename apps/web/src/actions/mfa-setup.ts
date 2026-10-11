'use server';

import { totpActivateSchema } from '@ghmt/shared';
import { isApiError } from '@/lib/api/errors';
import { describeApiError } from '@/lib/api/messages';
import { rec, str } from '@/lib/domain/raw';
import { backupCodesOf, buildTotpSetup } from '@/lib/domain/totp';
import { fieldErrorsFromZod, formDataToFlat, type FormState } from '@/lib/forms';
import { replaceAccessToken } from '@/lib/session/store';
import { actionApi } from '@/server/api';
import { failureState } from './helpers';

const EMAIL_CODE = /^\d{6}$/;
const EMAIL_CODE_STEP: FormState['extra'] = { emailCodeRequired: true };

/**
 * Démarre l'enrôlement : le QR code est généré côté serveur (aucune bibliothèque dans le navigateur).
 * Hors réseau de confiance, l'API exige un code reçu par e-mail (docs/11 D7) : `emailCodeRequired` ouvre cette étape.
 */
export async function startTotpSetupAction(emailCode?: string): Promise<FormState> {
  const code = typeof emailCode === 'string' ? emailCode.replace(/\s/g, '') : undefined;
  if (code !== undefined && !EMAIL_CODE.test(code)) {
    return { ok: false, fieldErrors: { emailCode: 'Saisissez le code à 6 chiffres reçu par e-mail.' }, extra: EMAIL_CODE_STEP };
  }
  try {
    const body = code === undefined ? {} : { body: { emailCode: code } };
    const setup = await buildTotpSetup((await actionApi('/auth/mfa/totp/setup', { method: 'POST', ...body })).data);
    if (!setup) return { ok: false, message: 'Réponse inattendue du serveur. Veuillez réessayer.' };
    return { ok: true, extra: { qrDataUrl: setup.qrDataUrl, secret: setup.secret } };
  } catch (error) {
    if (isApiError(error) && error.code === 'mfa_email_code_required') return { ok: false, extra: EMAIL_CODE_STEP };
    if (isApiError(error) && error.code === 'invalid_email_code') {
      return { ok: false, fieldErrors: { emailCode: describeApiError(error) }, extra: EMAIL_CODE_STEP };
    }
    return failureState(error);
  }
}

/** Envoie le code à 6 chiffres à l'adresse du compte (adresse masquée renvoyée par l'API). */
export async function sendMfaEmailCodeAction(): Promise<FormState> {
  try {
    const { data } = await actionApi('/auth/mfa/totp/email-code', { method: 'POST' });
    const emailMasked = str(rec(data).emailMasked);
    return {
      ok: true,
      message: emailMasked ? `Un code à 6 chiffres vient d'être envoyé à ${emailMasked}.` : 'Un code à 6 chiffres vient d\'être envoyé à l\'adresse de votre compte.',
      extra: emailMasked ? { emailMasked } : {},
    };
  } catch (error) {
    // Réseau de confiance : aucun code n'est exigé, l'enrôlement peut démarrer directement.
    if (isApiError(error) && error.code === 'email_code_not_required') return { ok: false, extra: { emailCodeNotRequired: true } };
    return failureState(error);
  }
}

export async function activateTotpAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const code = (formDataToFlat(formData).code ?? '').replace(/\s/g, '');
  const parsed = totpActivateSchema.safeParse({ code });
  if (!parsed.success) {
    return { ok: false, message: 'Saisissez le code à 6 chiffres affiché dans votre application.', fieldErrors: fieldErrorsFromZod(parsed.error) };
  }
  try {
    const { data } = await actionApi<unknown>('/auth/mfa/totp/activate', { method: 'POST', body: parsed.data });
    const accessToken = (data as { accessToken?: unknown } | null)?.accessToken;
    if (typeof accessToken === 'string' && accessToken.length > 0) await replaceAccessToken(accessToken);
    return { ok: true, message: 'Authentification à deux facteurs activée.', extra: { backupCodes: backupCodesOf(data) } };
  } catch (error) {
    return failureState(error);
  }
}
