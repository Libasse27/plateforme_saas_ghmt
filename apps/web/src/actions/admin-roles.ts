'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { roleForm } from '@/lib/domain/admin-forms';
import { rec, str } from '@/lib/domain/raw';
import { formDataToFlat, publicValues, type FormState } from '@/lib/forms';
import { actionApi } from '@/server/api';
import { INVALID_REQUEST, pathId } from './context';
import { checked, runMutation } from './admin-common';
import { failureState } from './helpers';

const ROLES_PATH = '/administration/roles';

/** Les cases de la matrice partagent le nom `permissions` : on lit toutes les valeurs. */
function permissionsOf(formData: FormData): string[] {
  return formData.getAll('permissions').filter((value): value is string => typeof value === 'string');
}

export async function createRoleAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const valid = checked(roleForm(flat, permissionsOf(formData), 'create'), publicValues(flat));
  if ('state' in valid) return valid.state;
  let createdId = '';
  try {
    createdId = str(rec((await actionApi('/iam/roles', { method: 'POST', body: valid.data })).data).id);
  } catch (error) {
    return failureState(error, publicValues(flat));
  }
  revalidatePath(ROLES_PATH);
  if (pathId(createdId)) redirect(`${ROLES_PATH}/${createdId}`);
  return { ok: true, message: 'Rôle créé.' };
}

export async function updateRoleAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const id = pathId(flat.id);
  if (!id) return INVALID_REQUEST;
  const valid = checked(roleForm(flat, permissionsOf(formData), 'update'), publicValues(flat));
  if ('state' in valid) return valid.state;
  return runMutation({ path: `/iam/roles/${id}`, method: 'PATCH', body: valid.data, values: publicValues(flat), revalidate: [ROLES_PATH, `${ROLES_PATH}/${id}`], message: 'Rôle mis à jour.' });
}

export async function deleteRoleAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const id = pathId(formDataToFlat(formData).id);
  if (!id) return INVALID_REQUEST;
  return runMutation({ path: `/iam/roles/${id}`, method: 'DELETE', revalidate: [ROLES_PATH], message: 'Rôle supprimé.', redirectTo: ROLES_PATH });
}
