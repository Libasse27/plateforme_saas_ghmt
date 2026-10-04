'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { changeAppointmentStatusSchema, createAppointmentSchema } from '@ghmt/shared';
import { parseMe } from '@/lib/auth/me';
import { remapSlotErrors } from '@/lib/domain/appointments';
import { fieldErrorsFromZod, formDataToFlat, publicValues, type FormState } from '@/lib/forms';
import { buildSlot, isValidTimeZone } from '@/lib/format/dates';
import { actionApi } from '@/server/api';
import { failureState, invalidState } from './helpers';

const MIN_DURATION = 5;
const MAX_DURATION = 240;

export async function createAppointmentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const values = publicValues(flat);
  const errors: Record<string, string> = {};

  const duration = Number(flat.duration);
  if (!Number.isInteger(duration) || duration < MIN_DURATION || duration > MAX_DURATION) {
    errors.duration = `La durée doit être comprise entre ${MIN_DURATION} et ${MAX_DURATION} minutes.`;
  }

  try {
    const timezone = parseMe((await actionApi('/auth/me')).data).tenant.timezone;
    const slot = isValidTimeZone(timezone) ? buildSlot(flat.date ?? '', flat.time ?? '', duration, timezone) : null;
    if (!slot) errors.time = 'Date ou heure invalide.';

    const parsed = createAppointmentSchema.safeParse({
      patientId: flat.patientId,
      practitionerId: flat.practitionerId,
      siteId: flat.siteId,
      reason: flat.reason?.trim() || undefined,
      source: 'front_desk',
      ...slot,
    });
    if (!parsed.success) {
      Object.assign(errors, remapSlotErrors({ ...fieldErrorsFromZod(parsed.error), ...errors }));
    }
    if (!parsed.success || Object.keys(errors).length > 0) return invalidState(errors, values);

    await actionApi('/appointments', { method: 'POST', body: parsed.data });
  } catch (error) {
    const failure = failureState(error, values);
    return failure.fieldErrors ? { ...failure, fieldErrors: remapSlotErrors(failure.fieldErrors) } : failure;
  }
  revalidatePath('/rendez-vous');
  revalidatePath('/');
  return { ok: true, message: 'Rendez-vous créé.', values: { date: flat.date ?? '' } };
}

export async function changeAppointmentStatusAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const id = z.uuid().safeParse(flat.appointmentId);
  const parsed = changeAppointmentStatusSchema.safeParse({
    status: flat.status,
    cancelReason: flat.cancelReason?.trim() || undefined,
  });
  if (!id.success || !parsed.success) return { ok: false, message: 'Demande invalide.' };
  if (parsed.data.status === 'cancelled' && !parsed.data.cancelReason) {
    return { ok: false, message: 'Indiquez le motif de l\'annulation.', fieldErrors: { cancelReason: 'Le motif est obligatoire.' } };
  }

  try {
    await actionApi(`/appointments/${id.data}/status`, { method: 'POST', body: parsed.data });
  } catch (error) {
    return failureState(error);
  }
  revalidatePath('/rendez-vous');
  revalidatePath('/');
  return { ok: true, message: 'Statut mis à jour.' };
}
