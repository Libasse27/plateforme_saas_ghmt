'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { practitionerForm } from '@/lib/domain/admin-forms';
import { rec, str } from '@/lib/domain/raw';
import { formDataToFlat, publicValues, type FormState } from '@/lib/forms';
import { actionApi } from '@/server/api';
import { INVALID_REQUEST, pathId } from './context';
import { checked, runMutation } from './admin-common';
import { failureState } from './helpers';

const PRACTITIONERS_PATH = '/administration/praticiens';

export async function createPractitionerAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const valid = checked(practitionerForm(flat, 'create'), publicValues(flat));
  if ('state' in valid) return valid.state;
  let createdId = '';
  try {
    createdId = str(rec((await actionApi('/practitioners', { method: 'POST', body: valid.data })).data).id);
  } catch (error) {
    return failureState(error, publicValues(flat));
  }
  revalidatePath(PRACTITIONERS_PATH);
  if (pathId(createdId)) redirect(`${PRACTITIONERS_PATH}/${createdId}`);
  return { ok: true, message: 'Praticien créé.' };
}

export async function updatePractitionerAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const id = pathId(flat.id);
  if (!id) return INVALID_REQUEST;
  const valid = checked(practitionerForm(flat, 'update'), publicValues(flat));
  if ('state' in valid) return valid.state;
  return runMutation({
    path: `/practitioners/${id}`,
    method: 'PATCH',
    body: valid.data,
    values: publicValues(flat),
    revalidate: [PRACTITIONERS_PATH, `${PRACTITIONERS_PATH}/${id}`],
    message: 'Praticien mis à jour.',
  });
}
