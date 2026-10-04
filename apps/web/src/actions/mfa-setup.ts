'use server';

import { totpActivateSchema } from '@ghmt/shared';
import { backupCodesOf, buildTotpSetup } from '@/lib/domain/totp';
import { fieldErrorsFromZod, formDataToFlat, type FormState } from '@/lib/forms';
import { replaceAccessToken } from '@/lib/session/store';
import { actionApi } from '@/server/api';
import { failureState } from './helpers';

/** Démarre l'enrôlement : le QR code est généré côté serveur (aucune bibliothèque dans le navigateur). */
export async function startTotpSetupAction(): Promise<FormState> {
  try {
    const setup = await buildTotpSetup((await actionApi('/auth/mfa/totp/setup', { method: 'POST' })).data);
    if (!setup) return { ok: false, message: 'Réponse inattendue du serveur. Veuillez réessayer.' };
    return { ok: true, extra: { qrDataUrl: setup.qrDataUrl, secret: setup.secret } };
  } catch (error) {
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
