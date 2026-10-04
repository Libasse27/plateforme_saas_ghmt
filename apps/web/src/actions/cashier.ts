'use server';

import { revalidatePath } from 'next/cache';
import { closeCashSessionSchema, createCashRegisterSchema, openCashSessionSchema, validateCashSessionSchema } from '@ghmt/shared';
import { toCashSession } from '@/lib/domain/billing';
import { formatMoney, parseMoneyInput } from '@/lib/domain/money';
import { fieldErrorsFromZod, formDataToFlat, publicValues, type FormState } from '@/lib/forms';
import { actionApi } from '@/server/api';
import { INVALID_REQUEST, pathId } from './context';
import { failureState, invalidState } from './helpers';

const CASHIER_PATH = '/caisse';

export async function createRegisterAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const parsed = createCashRegisterSchema.safeParse({ siteId: flat.siteId, code: flat.code?.trim(), name: flat.name });
  if (!parsed.success) return invalidState(fieldErrorsFromZod(parsed.error), publicValues(flat));
  try {
    await actionApi('/cashier/registers', { method: 'POST', body: parsed.data });
  } catch (error) {
    return failureState(error, publicValues(flat));
  }
  revalidatePath(CASHIER_PATH);
  return { ok: true, message: 'Caisse créée.' };
}

export async function openSessionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const floatAmount = parseMoneyInput(flat.openingFloat ?? '');
  if (!floatAmount.ok) return invalidState({ openingFloat: floatAmount.error }, publicValues(flat));
  const parsed = openCashSessionSchema.safeParse({ cashRegisterId: flat.cashRegisterId, openingFloat: floatAmount.amount });
  if (!parsed.success) return invalidState(fieldErrorsFromZod(parsed.error), publicValues(flat));
  try {
    await actionApi('/cashier/sessions', { method: 'POST', body: parsed.data });
  } catch (error) {
    return failureState(error, publicValues(flat));
  }
  revalidatePath(CASHIER_PATH);
  return { ok: true, message: 'Session de caisse ouverte. Vous pouvez encaisser en espèces.' };
}

/** Clôture par l'ouvreur : montant compté ⇒ attendu et écart sont renvoyés par l'API et affichés. */
export async function closeSessionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const id = pathId(flat.sessionId);
  if (!id) return INVALID_REQUEST;
  const counted = parseMoneyInput(flat.countedAmount ?? '');
  if (!counted.ok) return invalidState({ countedAmount: counted.error }, publicValues(flat));
  const parsed = closeCashSessionSchema.safeParse({ countedAmount: counted.amount, note: flat.note?.trim() || undefined });
  if (!parsed.success) return invalidState(fieldErrorsFromZod(parsed.error), publicValues(flat));
  let session;
  try {
    session = toCashSession((await actionApi(`/cashier/sessions/${id}/close`, { method: 'POST', body: parsed.data })).data);
  } catch (error) {
    return failureState(error, publicValues(flat));
  }
  revalidatePath(CASHIER_PATH);
  const { currency } = session;
  return {
    ok: true,
    message: `Session clôturée. Attendu : ${formatMoney(session.expectedTotal, currency)} ; compté : ${formatMoney(session.closingCounted, currency)} ; écart : ${formatMoney(session.variance, currency)}.`,
  };
}

/** Validation par un autre utilisateur que l'ouvreur et le clôturant (séparation des tâches, garantie aussi par l'API). */
export async function validateSessionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const id = pathId(flat.sessionId);
  const parsed = validateCashSessionSchema.safeParse({ note: flat.note?.trim() || undefined });
  if (!id || !parsed.success) return INVALID_REQUEST;
  try {
    await actionApi(`/cashier/sessions/${id}/validate`, { method: 'POST', body: parsed.data });
  } catch (error) {
    return failureState(error);
  }
  revalidatePath(CASHIER_PATH);
  return { ok: true, message: 'Session validée.' };
}
