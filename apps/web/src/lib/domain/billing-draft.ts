import { ITEM_CATEGORIES, type ItemCategory } from '@ghmt/shared';
import { invoiceTotals } from './billing';
import { parseMoneyInput, parseQuantityInput, sumAmounts } from './money';

export type DraftLine =
  | { readonly key: string; readonly kind: 'catalog'; readonly priceListItemId: string; readonly label: string; readonly unitPrice: string; readonly quantity: string }
  | { readonly key: string; readonly kind: 'free'; readonly description: string; readonly category: ItemCategory; readonly unitPrice: string; readonly quantity: string };

export type DraftResult = { readonly ok: true; readonly lines: readonly DraftLine[] } | { readonly ok: false; readonly error: string };

export interface CatalogItemRef {
  readonly id: string;
  readonly label: string;
  readonly unitPrice: string;
}

export interface FreeLineInput {
  readonly description: string;
  readonly category: string;
  readonly unitPrice: string;
  readonly quantity: string;
}

export function addCatalogLine(lines: readonly DraftLine[], item: CatalogItemRef, quantityRaw: string, key: string): DraftResult {
  const quantity = parseQuantityInput(quantityRaw);
  if (!quantity.ok) return { ok: false, error: quantity.error };
  const existing = lines.find((line) => line.kind === 'catalog' && line.priceListItemId === item.id);
  if (existing) {
    const merged = parseQuantityInput(sumQuantities(existing.quantity, quantity.quantity));
    if (!merged.ok) return { ok: false, error: merged.error };
    return { ok: true, lines: lines.map((line) => (line.key === existing.key ? { ...line, quantity: merged.quantity } : line)) };
  }
  return { ok: true, lines: [...lines, { key, kind: 'catalog', priceListItemId: item.id, label: item.label, unitPrice: item.unitPrice, quantity: quantity.quantity }] };
}

/** Somme de deux quantités décimales (3 décimales) sans flottant. */
function sumQuantities(left: string, right: string): string {
  const scale = (value: string): bigint => {
    const [integer = '0', fraction = ''] = value.split('.');
    return BigInt(integer) * 1000n + BigInt(fraction.padEnd(3, '0').slice(0, 3));
  };
  const total = scale(left) + scale(right);
  const fraction = (total % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return `${(total / 1000n).toString()}${fraction ? `.${fraction}` : ''}`;
}

export function addFreeLine(lines: readonly DraftLine[], input: FreeLineInput, key: string): DraftResult {
  const description = input.description.trim();
  if (description.length < 2) return { ok: false, error: 'Le libellé doit comporter au moins 2 caractères.' };
  if (!(ITEM_CATEGORIES as readonly string[]).includes(input.category)) return { ok: false, error: 'Choisissez une catégorie.' };
  const price = parseMoneyInput(input.unitPrice);
  if (!price.ok) return { ok: false, error: price.error };
  const quantity = parseQuantityInput(input.quantity);
  if (!quantity.ok) return { ok: false, error: quantity.error };
  return {
    ok: true,
    lines: [...lines, { key, kind: 'free', description, category: input.category as ItemCategory, unitPrice: price.amount, quantity: quantity.quantity }],
  };
}

export function removeLine(lines: readonly DraftLine[], key: string): DraftLine[] {
  return lines.filter((line) => line.key !== key);
}

export function draftTotal(lines: readonly DraftLine[]): string {
  return lines.length === 0 ? sumAmounts([]) : invoiceTotals(lines);
}

/** JSON du champ caché relu par `parseDraftLines` côté serveur (le serveur revalide tout). */
export function serializeLines(lines: readonly DraftLine[]): string {
  return JSON.stringify(
    lines.map((line) =>
      line.kind === 'catalog'
        ? { kind: 'catalog', priceListItemId: line.priceListItemId, quantity: line.quantity }
        : { kind: 'free', description: line.description, category: line.category, unitPrice: line.unitPrice, quantity: line.quantity },
    ),
  );
}
