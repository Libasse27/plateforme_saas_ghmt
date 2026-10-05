'use server';

import { revalidatePath } from 'next/cache';
import { CONSENT_CHANNELS } from '@/lib/domain/notifications';
import { formDataToFlat, type FormState } from '@/lib/forms';
import { actionApi } from '@/server/api';
import { INVALID_REQUEST, pathId } from './context';
import { failureState } from './helpers';

/** Saisie à l'accueil du consentement aux rappels (source `front_desk`) : le corps part en POST, jamais dans l'URL du navigateur. */
export async function recordConsentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const patientId = pathId(flat.patientId);
  const channel = (CONSENT_CHANNELS as readonly string[]).find((candidate) => candidate === flat.channel);
  if (!patientId || !channel || (flat.granted !== 'true' && flat.granted !== 'false')) return INVALID_REQUEST;
  const granted = flat.granted === 'true';
  try {
    await actionApi(`/patients/${patientId}/contact-consents`, {
      method: 'POST',
      body: { channel, purpose: 'appointment_reminder', granted, source: 'front_desk' },
    });
  } catch (error) {
    return failureState(error);
  }
  revalidatePath(`/patients/${patientId}`);
  const label = channel === 'sms' ? 'SMS' : 'e-mail';
  return { ok: true, message: granted ? `Consentement ${label} accordé.` : `Consentement ${label} révoqué.` };
}
