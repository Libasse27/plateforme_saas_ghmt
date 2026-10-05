'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createInvoiceSchema } from '@ghmt/shared';
import { isApiError } from '@/lib/api/errors';
import { hasPermission } from '@/lib/auth/me';
import { buildVoidInput, parseDraftLines } from '@/lib/domain/billing';
import { str, rec } from '@/lib/domain/raw';
import { fieldErrorsFromZod, formDataToFlat, publicValues, type FormState } from '@/lib/forms';
import { actionApi } from '@/server/api';
import { currencyOf, currentMe, INVALID_REQUEST, pathId } from './context';
import { failureState, invalidState } from './helpers';

const INVOICES_PATH = '/facturation/factures';

/**
 * Création d'une facture (brouillon, ou brouillon puis émission). Le patient vient de la recherche POST,
 * jamais d'un terme dans l'URL ; les lignes libres exigent `billing:invoice:update` (revérifié par l'API).
 */
export async function createInvoiceAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const values = publicValues(flat);
  const errors: Record<string, string> = {};

  let invoiceId: string;
  try {
    const me = await currentMe();
    const lines = parseDraftLines(flat.lines, hasPermission(me, 'billing:invoice:update'), currencyOf(flat.currency));
    if (!lines.ok) errors.lines = lines.error;
    const parsed = createInvoiceSchema.safeParse({
      patientId: flat.patientId,
      siteId: flat.siteId,
      appointmentId: flat.appointmentId || undefined,
      notes: flat.notes?.trim() || undefined,
      lines: lines.ok ? lines.lines : [],
    });
    if (!parsed.success) {
      const zodErrors = fieldErrorsFromZod(parsed.error);
      for (const [path, message] of Object.entries(zodErrors)) {
        if (!(path.startsWith('lines') && errors.lines)) errors[path] = message;
      }
      if (zodErrors.patientId) errors.patientId = 'Choisissez le patient à facturer.';
      if (zodErrors.siteId) errors.siteId = 'Choisissez le site.';
    }
    if (!parsed.success || Object.keys(errors).length > 0) return invalidState(errors, values);

    const created = await actionApi('/billing/invoices', { method: 'POST', body: parsed.data });
    invoiceId = str(rec(created.data).id);
  } catch (error) {
    return failureState(error, values);
  }
  if (!pathId(invoiceId)) redirect(INVOICES_PATH);

  if (flat.intent === 'issue') {
    try {
      await actionApi(`/billing/invoices/${invoiceId}/issue`, { method: 'POST' });
    } catch (error) {
      // Le brouillon existe : le détail permet de réessayer l'émission.
      if (!isApiError(error)) throw error;
    }
  }
  revalidatePath(INVOICES_PATH);
  redirect(`${INVOICES_PATH}/${invoiceId}`);
}

export async function issueInvoiceAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const id = pathId(formDataToFlat(formData).invoiceId);
  if (!id) return INVALID_REQUEST;
  try {
    await actionApi(`/billing/invoices/${id}/issue`, { method: 'POST' });
  } catch (error) {
    return failureState(error);
  }
  revalidatePath(`${INVOICES_PATH}/${id}`);
  revalidatePath(INVOICES_PATH);
  return { ok: true, message: 'Facture émise : son numéro est attribué et elle ne peut plus être modifiée.' };
}

export async function voidInvoiceAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const id = pathId(flat.invoiceId);
  if (!id) return INVALID_REQUEST;
  const built = buildVoidInput(flat);
  if (!built.ok) return invalidState(built.fieldErrors, publicValues(flat));
  try {
    await actionApi(`/billing/invoices/${id}/void`, { method: 'POST', body: built.body });
  } catch (error) {
    return failureState(error, publicValues(flat));
  }
  revalidatePath(`${INVOICES_PATH}/${id}`);
  revalidatePath(INVOICES_PATH);
  return { ok: true, message: 'Facture annulée.' };
}
