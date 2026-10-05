'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { updateUserSchema } from '@ghmt/shared';
import { isApiError } from '@/lib/api/errors';
import { assignmentForm, inviteForm } from '@/lib/domain/admin-forms';
import { rec, str } from '@/lib/domain/raw';
import { fieldErrorsFromZod, formDataToFlat, publicValues, type FormState } from '@/lib/forms';
import { actionApi } from '@/server/api';
import { INVALID_REQUEST, pathId } from './context';
import { checked, runMutation } from './admin-common';
import { failureState, invalidState } from './helpers';

const USERS_PATH = '/administration/utilisateurs';
const userPath = (id: string): string => `${USERS_PATH}/${id}`;

export async function inviteUserAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const valid = checked(inviteForm(flat), publicValues(flat));
  if ('state' in valid) return valid.state;
  let createdId = '';
  try {
    createdId = str(rec((await actionApi('/iam/users', { method: 'POST', body: valid.data })).data).id);
  } catch (error) {
    // Le compte existe déjà : la liste doit le montrer pour que l'invitation puisse être renvoyée.
    if (isApiError(error) && error.code === 'invitation_email_failed') revalidatePath(USERS_PATH);
    return failureState(error, publicValues(flat));
  }
  revalidatePath(USERS_PATH);
  if (pathId(createdId)) redirect(userPath(createdId));
  return { ok: true, message: 'Invitation envoyée.' };
}

export async function updateUserAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const id = pathId(flat.userId);
  if (!id) return INVALID_REQUEST;
  const parsed = updateUserSchema.safeParse({ fullName: flat.fullName?.trim(), locale: flat.locale });
  if (!parsed.success) return invalidState(fieldErrorsFromZod(parsed.error), publicValues(flat));
  return runMutation({ path: `/iam/users/${id}`, method: 'PATCH', body: parsed.data, values: publicValues(flat), revalidate: [USERS_PATH, userPath(id)], message: 'Utilisateur mis à jour.' });
}

function userCommand(suffix: string, method: 'POST' | 'DELETE', message: string) {
  return async (_prev: FormState, formData: FormData): Promise<FormState> => {
    const id = pathId(formDataToFlat(formData).userId);
    if (!id) return INVALID_REQUEST;
    return runMutation({ path: `/iam/users/${id}/${suffix}`, method, revalidate: [USERS_PATH, userPath(id)], message });
  };
}

export const resendInvitationAction = async (prev: FormState, formData: FormData): Promise<FormState> =>
  userCommand('invitation', 'POST', 'Invitation renvoyée.')(prev, formData);
export const disableUserAction = async (prev: FormState, formData: FormData): Promise<FormState> =>
  userCommand('disable', 'POST', 'Compte désactivé.')(prev, formData);
export const enableUserAction = async (prev: FormState, formData: FormData): Promise<FormState> =>
  userCommand('enable', 'POST', 'Compte réactivé.')(prev, formData);
export const unlockUserAction = async (prev: FormState, formData: FormData): Promise<FormState> =>
  userCommand('unlock', 'POST', 'Compte déverrouillé.')(prev, formData);
export const revokeSessionsAction = async (prev: FormState, formData: FormData): Promise<FormState> =>
  userCommand('sessions', 'DELETE', 'Toutes les sessions de l\'utilisateur ont été révoquées.')(prev, formData);

export async function addAssignmentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const id = pathId(flat.userId);
  if (!id) return INVALID_REQUEST;
  const valid = checked(assignmentForm(flat), publicValues(flat));
  if ('state' in valid) return valid.state;
  return runMutation({ path: `/iam/users/${id}/assignments`, method: 'POST', body: valid.data, values: publicValues(flat), revalidate: [userPath(id)], message: 'Affectation ajoutée.' });
}

export async function revokeAssignmentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const id = pathId(flat.userId);
  const assignmentId = pathId(flat.assignmentId);
  if (!id || !assignmentId) return INVALID_REQUEST;
  return runMutation({ path: `/iam/users/${id}/assignments/${assignmentId}`, method: 'DELETE', revalidate: [userPath(id)], message: 'Affectation retirée.' });
}
