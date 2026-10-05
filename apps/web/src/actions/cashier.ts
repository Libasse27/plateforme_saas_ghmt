'use server';

import { revalidatePath } from 'next/cache';
import { closeCashSessionSchema, createCashRegisterSchema, openCashSessionSchema, validateCashSessionSchema } from '@ghmt/shared';
import { toCashSession } from '@/lib/domain/billing';
import { formatMoney, parseMoneyInput, subtractAmounts } from '@/lib/domain/money';
import { fieldErrorsFromZod, formDataToFlat, publicValues, type FormState } from '@/lib/forms';
import { actionApi } from '@/server/api';
import { currencyOf, INVALID_REQUEST, pathId } from './context';
import { failureState, invalidState } from './helpers';

const CASHIER_PATH = '/caisse';
const VARIANCE_NOTE_REQUIRED = 'L\'écart est non nul : expliquez-le dans la note (obligatoire).';
const FORCE_REASON_MIN = 3;
const FORCE_REASON_MAX = 500;

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
  const floatAmount = parseMoneyInput(flat.openingFloat ?? '', currencyOf(flat.currency));
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
  const counted = parseMoneyInput(flat.countedAmount ?? '', currencyOf(flat.currency));
  if (!counted.ok) return invalidState({ countedAmount: counted.error }, publicValues(flat));
  // Écart ≠ 0 : note obligatoire (R8). L'attendu vient du formulaire (affichage) ; l'API reste l'autorité.
  const note = flat.note?.trim() ?? '';
  if (!note && flat.expectedTotal && /^-?\d+(\.\d+)?$/.test(flat.expectedTotal) && /[1-9]/.test(subtractAmounts(counted.amount, flat.expectedTotal))) {
    return invalidState({ note: VARIANCE_NOTE_REQUIRED }, publicValues(flat));
  }
  const parsed = closeCashSessionSchema.safeParse({ countedAmount: counted.amount, note: note || undefined });
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

/** Clôture forcée par un responsable (R8) : montant compté et motif obligatoires ; interdite à l'ouvreur (revérifié par l'API). */
export async function forceCloseSessionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const id = pathId(flat.sessionId);
  if (!id) return INVALID_REQUEST;
  const errors: Record<string, string> = {};
  const counted = parseMoneyInput(flat.countedAmount ?? '', currencyOf(flat.currency));
  if (!counted.ok) errors.countedAmount = counted.error;
  const reason = (flat.reason ?? '').trim();
  if (reason.length < FORCE_REASON_MIN) errors.reason = `Indiquez le motif de la clôture forcée (${String(FORCE_REASON_MIN)} caractères au moins).`;
  else if (reason.length > FORCE_REASON_MAX) errors.reason = `Le motif ne peut pas dépasser ${String(FORCE_REASON_MAX)} caractères.`;
  if (!counted.ok || Object.keys(errors).length > 0) return invalidState(errors, publicValues(flat));
  let session;
  try {
    session = toCashSession((await actionApi(`/cashier/sessions/${id}/force-close`, { method: 'POST', body: { countedAmount: counted.amount, reason } })).data);
  } catch (error) {
    return failureState(error, publicValues(flat));
  }
  revalidatePath(CASHIER_PATH);
  return {
    ok: true,
    message: `Session clôturée de force. Attendu : ${formatMoney(session.expectedTotal, session.currency)} ; compté : ${formatMoney(session.closingCounted, session.currency)} ; écart : ${formatMoney(session.variance, session.currency)}.`,
  };
}
