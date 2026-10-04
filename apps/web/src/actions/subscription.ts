'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { changePlanSchema, payInvoiceSchema } from '@ghmt/shared';
import { toChangePlanResult, toPayCheckout, checkoutRedirectTarget, changeResultMessage } from '@/lib/domain/subscription';
import { normalizePhone } from '@/lib/domain/phone';
import { fieldErrorsFromZod, formDataToFlat, publicValues, type FormState } from '@/lib/forms';
import { actionApi } from '@/server/api';
import { currentMe, INVALID_REQUEST, pathId } from './context';
import { failureState, invalidState } from './helpers';

const SUBSCRIPTION_PATH = '/abonnement';

function refreshSubscriptionViews(): void {
  revalidatePath(SUBSCRIPTION_PATH);
  revalidatePath('/', 'layout');
}

export async function changePlanAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const parsed = changePlanSchema.safeParse({ planCode: flat.planCode, billingPeriod: flat.billingPeriod });
  if (!parsed.success) return invalidState(fieldErrorsFromZod(parsed.error), publicValues(flat));
  try {
    const result = toChangePlanResult((await actionApi('/subscription/change', { method: 'POST', body: parsed.data })).data);
    const { tenant } = await currentMe();
    refreshSubscriptionViews();
    return { ok: true, message: changeResultMessage(result, tenant.timezone) };
  } catch (error) {
    return failureState(error);
  }
}

async function lifecycleAction(path: '/subscription/cancel' | '/subscription/resume', message: string): Promise<FormState> {
  try {
    await actionApi(path, { method: 'POST' });
  } catch (error) {
    return failureState(error);
  }
  refreshSubscriptionViews();
  return { ok: true, message };
}

export async function cancelSubscriptionAction(): Promise<FormState> {
  return lifecycleAction('/subscription/cancel', 'Résiliation programmée à la fin de la période en cours.');
}

export async function resumeSubscriptionAction(): Promise<FormState> {
  return lifecycleAction('/subscription/resume', 'Abonnement repris : la résiliation est annulée.');
}

/** Paiement Mobile Money d'une facture SaaS : le numéro est normalisé (E.164) puis envoyé en POST, jamais dans l'URL. */
export async function paySaasInvoiceAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const invoiceId = pathId(flat.invoiceId);
  if (!invoiceId) return INVALID_REQUEST;

  let target: string | null;
  let instructions: string | null;
  try {
    const { tenant } = await currentMe();
    const phone = normalizePhone(flat.payerPhone ?? '', tenant.countryCode);
    if (!phone.ok) return { ok: false, message: phone.error, fieldErrors: { payerPhone: phone.error } };
    const body = payInvoiceSchema.parse({ payerPhone: phone.e164 });
    const checkout = toPayCheckout((await actionApi(`/subscription/invoices/${invoiceId}/pay`, { method: 'POST', body })).data);
    target = checkoutRedirectTarget(checkout.checkoutUrl, SUBSCRIPTION_PATH, process.env.NODE_ENV === 'production');
    instructions = checkout.instructions;
  } catch (error) {
    return failureState(error);
  }
  refreshSubscriptionViews();
  if (target) redirect(target);
  return { ok: true, message: 'Demande de paiement envoyée.', extra: { instructions } };
}
