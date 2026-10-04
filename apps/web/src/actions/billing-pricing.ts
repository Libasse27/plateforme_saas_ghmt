'use server';

import { revalidatePath } from 'next/cache';
import { createPriceListItemSchema, createPriceListSchema, updatePriceListItemSchema, updatePriceListSchema } from '@ghmt/shared';
import { parseMoneyInput } from '@/lib/domain/money';
import { fieldErrorsFromZod, formDataToFlat, publicValues, type FormState } from '@/lib/forms';
import { actionApi } from '@/server/api';
import { INVALID_REQUEST, pathId } from './context';
import { failureState, invalidState } from './helpers';

const PRICING_PATH = '/facturation/tarifs';

export async function createPriceListAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const parsed = createPriceListSchema.safeParse({ code: flat.code?.trim(), name: flat.name, isDefault: flat.isDefault === 'on' });
  if (!parsed.success) return invalidState(fieldErrorsFromZod(parsed.error), publicValues(flat));
  try {
    await actionApi('/billing/price-lists', { method: 'POST', body: parsed.data });
  } catch (error) {
    return failureState(error, publicValues(flat));
  }
  revalidatePath(PRICING_PATH);
  return { ok: true, message: 'Grille tarifaire créée.' };
}

export async function setDefaultPriceListAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const id = pathId(formDataToFlat(formData).priceListId);
  const parsed = updatePriceListSchema.safeParse({ isDefault: true });
  if (!id || !parsed.success) return INVALID_REQUEST;
  try {
    await actionApi(`/billing/price-lists/${id}`, { method: 'PATCH', body: parsed.data });
  } catch (error) {
    return failureState(error);
  }
  revalidatePath(PRICING_PATH);
  return { ok: true, message: 'Grille désignée par défaut.' };
}

export async function createPriceItemAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const priceListId = pathId(flat.priceListId);
  if (!priceListId) return INVALID_REQUEST;
  const price = parseMoneyInput(flat.unitPrice ?? '');
  const parsed = createPriceListItemSchema.safeParse({
    code: flat.code?.trim(),
    label: flat.label,
    category: flat.category,
    unitPrice: price.ok ? price.amount : '',
    isActive: true,
  });
  const errors = { ...(parsed.success ? {} : fieldErrorsFromZod(parsed.error)), ...(price.ok ? {} : { unitPrice: price.error }) };
  if (!parsed.success || Object.keys(errors).length > 0) return invalidState(errors, publicValues(flat));
  try {
    await actionApi(`/billing/price-lists/${priceListId}/items`, { method: 'POST', body: parsed.data });
  } catch (error) {
    return failureState(error, publicValues(flat));
  }
  revalidatePath(PRICING_PATH);
  return { ok: true, message: 'Article ajouté à la grille.' };
}

/** Modification du prix (audité côté API) ou activation/désactivation ; les factures existantes gardent leur prix figé. */
export async function updatePriceItemAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const itemId = pathId(flat.itemId);
  if (!itemId) return INVALID_REQUEST;
  const patch: Record<string, unknown> = {};
  if (flat.unitPrice !== undefined) {
    const price = parseMoneyInput(flat.unitPrice);
    if (!price.ok) return invalidState({ unitPrice: price.error }, publicValues(flat));
    patch.unitPrice = price.amount;
  }
  if (flat.isActive === 'true' || flat.isActive === 'false') patch.isActive = flat.isActive === 'true';
  const parsed = updatePriceListItemSchema.safeParse(patch);
  if (!parsed.success) return invalidState(fieldErrorsFromZod(parsed.error), publicValues(flat));
  try {
    await actionApi(`/billing/price-list-items/${itemId}`, { method: 'PATCH', body: parsed.data });
  } catch (error) {
    return failureState(error, publicValues(flat));
  }
  revalidatePath(PRICING_PATH);
  return { ok: true, message: 'Article mis à jour.' };
}
