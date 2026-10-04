'use server';

import { revalidatePath } from 'next/cache';
import { platformChangePlanSchema, rejectManualPaymentSchema, suspendTenantSchema } from '@ghmt/shared';
import { buildManualPaymentInput, buildPlanVersionInput } from '@/lib/domain/platform';
import { fieldErrorsFromZod, formDataToFlat, publicValues, type FormState } from '@/lib/forms';
import { platformActionApi } from '@/server/platform-api';
import { INVALID_REQUEST, pathId } from './context';
import { failureState, invalidState } from './helpers';

const CONSOLE = '/plateforme';

async function post(path: string, body?: unknown): Promise<void> {
  await platformActionApi(path, { method: 'POST', ...(body !== undefined ? { body } : {}) });
}

export async function suspendTenantAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const id = pathId(flat.tenantId);
  if (!id) return INVALID_REQUEST;
  const parsed = suspendTenantSchema.safeParse({ reason: flat.reason });
  if (!parsed.success) return invalidState({ reason: 'Indiquez le motif de la suspension (5 à 500 caractères).' }, publicValues(flat));
  try {
    await post(`/platform/tenants/${id}/suspend`, parsed.data);
  } catch (error) {
    return failureState(error, publicValues(flat));
  }
  revalidatePath(`${CONSOLE}/etablissements/${id}`);
  revalidatePath(`${CONSOLE}/etablissements`);
  return { ok: true, message: 'Établissement suspendu : il est désormais en lecture seule.' };
}

export async function reactivateTenantAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const id = pathId(formDataToFlat(formData).tenantId);
  if (!id) return INVALID_REQUEST;
  try {
    await post(`/platform/tenants/${id}/reactivate`);
  } catch (error) {
    return failureState(error);
  }
  revalidatePath(`${CONSOLE}/etablissements/${id}`);
  revalidatePath(`${CONSOLE}/etablissements`);
  return { ok: true, message: 'Établissement réactivé.' };
}

export async function createPlanVersionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const built = buildPlanVersionInput(flat);
  if (!built.ok) return invalidState(built.fieldErrors, publicValues(flat));
  try {
    await post('/platform/plans', built.body);
  } catch (error) {
    return failureState(error, publicValues(flat));
  }
  revalidatePath(`${CONSOLE}/plans`);
  return { ok: true, message: `Nouvelle version du plan « ${built.body.name} » publiée ; la précédente est archivée.` };
}

export async function changeTenantPlanAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const id = pathId(flat.tenantId);
  if (!id) return INVALID_REQUEST;
  const parsed = platformChangePlanSchema.safeParse({ planCode: flat.planCode, billingPeriod: flat.billingPeriod });
  if (!parsed.success) return invalidState(fieldErrorsFromZod(parsed.error), publicValues(flat));
  try {
    await post(`/platform/subscriptions/${id}/change`, parsed.data);
  } catch (error) {
    return failureState(error, publicValues(flat));
  }
  revalidatePath(`${CONSOLE}/abonnements/${id}`);
  revalidatePath(`${CONSOLE}/etablissements/${id}`);
  return { ok: true, message: 'Plan modifié.' };
}

export async function extendTrialAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const id = pathId(formDataToFlat(formData).tenantId);
  if (!id) return INVALID_REQUEST;
  try {
    await post(`/platform/subscriptions/${id}/extend-trial`);
  } catch (error) {
    return failureState(error);
  }
  revalidatePath(`${CONSOLE}/abonnements/${id}`);
  return { ok: true, message: 'Essai prolongé de 15 jours.' };
}

export async function recordManualPaymentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const invoiceId = pathId(flat.invoiceId);
  if (!invoiceId) return INVALID_REQUEST;
  const built = buildManualPaymentInput(flat);
  if (!built.ok) return invalidState(built.fieldErrors, publicValues(flat));
  try {
    await post(`/platform/invoices/${invoiceId}/manual-payments`, built.body);
  } catch (error) {
    return failureState(error, publicValues(flat));
  }
  revalidatePath(`${CONSOLE}/factures`);
  return { ok: true, message: 'Paiement manuel saisi : il doit être validé par un autre administrateur.' };
}

export async function validateManualPaymentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const id = pathId(formDataToFlat(formData).paymentId);
  if (!id) return INVALID_REQUEST;
  try {
    await post(`/platform/invoices/manual-payments/${id}/validate`);
  } catch (error) {
    return failureState(error);
  }
  revalidatePath(`${CONSOLE}/factures`);
  return { ok: true, message: 'Paiement validé : la facture est réglée et l\'abonnement activé.' };
}

export async function rejectManualPaymentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const id = pathId(flat.paymentId);
  if (!id) return INVALID_REQUEST;
  const parsed = rejectManualPaymentSchema.safeParse({ reason: flat.reason });
  if (!parsed.success) return invalidState({ reason: 'Indiquez le motif du rejet (5 à 500 caractères).' }, publicValues(flat));
  try {
    await post(`/platform/invoices/manual-payments/${id}/reject`, parsed.data);
  } catch (error) {
    return failureState(error, publicValues(flat));
  }
  revalidatePath(`${CONSOLE}/factures`);
  return { ok: true, message: 'Paiement rejeté.' };
}
