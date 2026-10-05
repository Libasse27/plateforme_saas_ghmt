'use server';

import { departmentForm, siteForm } from '@/lib/domain/admin-forms';
import { formDataToFlat, publicValues, type FormState } from '@/lib/forms';
import { INVALID_REQUEST, pathId } from './context';
import { checked, runMutation } from './admin-common';

const ORGANISATION_PATH = '/administration/organisation';

export async function createSiteAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const result = siteForm(flat, 'create');
  const valid = checked(result, publicValues(flat));
  if ('state' in valid) return valid.state;
  return runMutation({ path: '/org/sites', method: 'POST', body: valid.data, values: publicValues(flat), revalidate: [ORGANISATION_PATH], message: 'Site créé.' });
}

export async function createDepartmentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const result = departmentForm(flat, 'create');
  const valid = checked(result, publicValues(flat));
  if ('state' in valid) return valid.state;
  return runMutation({ path: '/org/departments', method: 'POST', body: valid.data, values: publicValues(flat), revalidate: [ORGANISATION_PATH], message: 'Service créé.' });
}

export async function updateSiteAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const id = pathId(flat.id);
  if (!id) return INVALID_REQUEST;
  const result = siteForm(flat, 'update');
  const valid = checked(result, publicValues(flat));
  if ('state' in valid) return valid.state;
  return runMutation({ path: `/org/sites/${id}`, method: 'PATCH', body: valid.data, values: publicValues(flat), revalidate: [ORGANISATION_PATH, `${ORGANISATION_PATH}/sites/${id}`], message: 'Site mis à jour.' });
}

export async function updateDepartmentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const id = pathId(flat.id);
  if (!id) return INVALID_REQUEST;
  const result = departmentForm(flat, 'update');
  const valid = checked(result, publicValues(flat));
  if ('state' in valid) return valid.state;
  return runMutation({ path: `/org/departments/${id}`, method: 'PATCH', body: valid.data, values: publicValues(flat), revalidate: [ORGANISATION_PATH, `${ORGANISATION_PATH}/services/${id}`], message: 'Service mis à jour.' });
}

export async function deleteSiteAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const id = pathId(formDataToFlat(formData).id);
  if (!id) return INVALID_REQUEST;
  return runMutation({ path: `/org/sites/${id}`, method: 'DELETE', revalidate: [ORGANISATION_PATH], message: 'Site supprimé.', redirectTo: ORGANISATION_PATH });
}

export async function deleteDepartmentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const id = pathId(formDataToFlat(formData).id);
  if (!id) return INVALID_REQUEST;
  return runMutation({ path: `/org/departments/${id}`, method: 'DELETE', revalidate: [ORGANISATION_PATH], message: 'Service supprimé.', redirectTo: ORGANISATION_PATH });
}
