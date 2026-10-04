'use server';

import QRCode from 'qrcode';
import { totpActivateSchema } from '@ghmt/shared';
import { fieldErrorsFromZod, formDataToFlat, type FormState } from '@/lib/forms';
import { replaceAccessToken } from '@/lib/session/store';
import { actionApi } from '@/server/api';
import { failureState } from './helpers';

const OTPAUTH_PREFIX = 'otpauth://';

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** Démarre l'enrôlement : le QR code est généré côté serveur (aucune bibliothèque dans le navigateur). */
export async function startTotpSetupAction(): Promise<FormState> {
  try {
    const data = asRecord((await actionApi('/auth/mfa/totp/setup', { method: 'POST' })).data);
    const { otpauthUrl, secret } = data;
    if (typeof otpauthUrl !== 'string' || !otpauthUrl.startsWith(OTPAUTH_PREFIX) || typeof secret !== 'string') {
      return { ok: false, message: 'Réponse inattendue du serveur. Veuillez réessayer.' };
    }
    const svg = await QRCode.toString(otpauthUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return { ok: true, extra: { qrDataUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, secret } };
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
    const data = asRecord((await actionApi('/auth/mfa/totp/activate', { method: 'POST', body: parsed.data })).data);
    const backupCodes = Array.isArray(data.backupCodes) ? data.backupCodes.filter((c): c is string => typeof c === 'string') : [];
    if (typeof data.accessToken === 'string' && data.accessToken.length > 0) await replaceAccessToken(data.accessToken);
    return { ok: true, message: 'Authentification à deux facteurs activée.', extra: { backupCodes } };
  } catch (error) {
    return failureState(error);
  }
}
