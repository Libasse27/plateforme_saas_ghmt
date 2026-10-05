'use server';

import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { sandboxSimulationSchema } from '@ghmt/shared';
import { buildPaymentInput, toInvoicePayment, toOnlinePayment } from '@/lib/domain/billing';
import { formatMoney } from '@/lib/domain/money';
import { rec, str } from '@/lib/domain/raw';
import { checkoutRedirectTarget } from '@/lib/domain/subscription';
import { formDataToFlat, publicValues, safeNextPath, type FormState } from '@/lib/forms';
import { actionApi, publicRequest } from '@/server/api';
import { currencyOf, currentMe, INVALID_REQUEST, pathId } from './context';
import { failureState, invalidState } from './helpers';

const INVOICES_PATH = '/facturation/factures';

/**
 * Encaissement depuis le détail d'une facture : espèces (session de caisse), Mobile Money (téléphone normalisé,
 * puis redirection vers l'URL de paiement ou affichage des instructions) ou autre mode (référence).
 */
export async function recordPaymentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const invoiceId = pathId(flat.invoiceId);
  if (!invoiceId) return INVALID_REQUEST;
  const values = publicValues(flat);
  const detailPath = `${INVOICES_PATH}/${invoiceId}`;

  let target: string | null = null;
  let instructions: string | null = null;
  let online = false;
  try {
    const { tenant } = await currentMe();
    const built = buildPaymentInput(flat, tenant.countryCode);
    if (!built.ok) return invalidState(built.fieldErrors, values);
    const { data } = await actionApi(`/billing/invoices/${invoiceId}/payments`, {
      method: 'POST',
      body: built.body,
    });
    online = built.body.method === 'mobile_money';
    if (online) {
      const checkout = toOnlinePayment(data);
      target = checkoutRedirectTarget(checkout.checkoutUrl, detailPath, process.env.NODE_ENV === 'production');
      instructions = checkout.instructions;
    }
  } catch (error) {
    return failureState(error, values, { currency: currencyOf(flat.currency) });
  }
  revalidatePath(detailPath);
  if (target) redirect(target);
  return online
    ? { ok: true, message: 'Demande de paiement envoyée. Une fois le paiement confirmé, actualisez son statut.', extra: { instructions } }
    : { ok: true, message: 'Paiement enregistré.' };
}

/** Reprise manuelle d'un paiement en ligne (webhook perdu) : l'API re-vérifie le statut auprès du fournisseur. */
export async function refreshPaymentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const paymentId = pathId(flat.paymentId);
  const invoiceId = pathId(flat.invoiceId);
  if (!paymentId || !invoiceId) return INVALID_REQUEST;
  let payment;
  try {
    payment = toInvoicePayment((await actionApi(`/billing/payments/${paymentId}/refresh`, { method: 'POST' })).data);
  } catch (error) {
    return failureState(error);
  }
  revalidatePath(`${INVOICES_PATH}/${invoiceId}`);
  if (payment.status === 'succeeded') return { ok: true, message: `Paiement confirmé (${formatMoney(payment.amount, payment.currency)}).` };
  if (payment.status === 'failed') return { ok: false, message: `Le paiement a échoué${payment.failureReason ? ` : ${payment.failureReason}` : ''}. Vous pouvez en lancer un nouveau.` };
  return { ok: true, message: 'Toujours en attente de confirmation par l\'opérateur.' };
}

/** Abandon d'un paiement en ligne en attente (R4) : l'API re-vérifie chez le fournisseur avant d'annuler. */
export async function abandonPaymentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const paymentId = pathId(flat.paymentId);
  const invoiceId = pathId(flat.invoiceId);
  if (!paymentId || !invoiceId) return INVALID_REQUEST;
  let status: string;
  try {
    status = str(rec((await actionApi(`/billing/payments/${paymentId}/abandon`, { method: 'POST' })).data).status);
  } catch (error) {
    return failureState(error);
  }
  revalidatePath(`${INVOICES_PATH}/${invoiceId}`);
  if (status === 'succeeded') return { ok: true, message: 'Le paiement a finalement été confirmé par l\'opérateur : il est enregistré et n\'a pas été annulé.' };
  if (status === 'cancelled') return { ok: true, message: 'Paiement en ligne abandonné : le montant est de nouveau disponible pour un nouvel encaissement.' };
  return { ok: false, message: 'Le paiement n\'a pas pu être abandonné. Actualisez la page puis réessayez.' };
}

const PROVIDER_REFERENCE = /^[A-Za-z0-9_-]{8,100}$/;

/** Simulation d'une issue de paiement du fournisseur sandbox (développement uniquement, 404 en production). */
export async function simulateSandboxPaymentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  if (process.env.NODE_ENV === 'production') notFound();
  const flat = formDataToFlat(formData);
  const parsed = sandboxSimulationSchema.safeParse({ providerReference: flat.providerReference, outcome: flat.outcome });
  if (!parsed.success || !PROVIDER_REFERENCE.test(flat.providerReference ?? '')) return INVALID_REQUEST;
  try {
    await publicRequest('/webhooks/payments/sandbox/simulate', { method: 'POST', body: parsed.data });
  } catch (error) {
    return failureState(error);
  }
  redirect(safeNextPath(flat.retour));
}
