/**
 * Montants : chaînes décimales (« 25000.00 ») de bout en bout, jamais de flottant.
 * L'arithmétique passe par des entiers en centimes (BigInt).
 */
const NBSP = ' ';
const CFA_CURRENCIES: ReadonlySet<string> = new Set(['XOF', 'XAF']);
/** Devises sans subdivision (R7) : montants et prix entiers. */
const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set(['XOF', 'XAF', 'GNF', 'CDF']);
const ZERO_DECIMAL_ERROR = 'Cette devise n\'a pas de subdivision : saisissez un montant entier, sans décimales (par exemple 25 000).';
const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;
const INPUT_MONEY = /^\d{1,16}(\.\d{1,2})?$/;
const INPUT_QUANTITY = /^\d{1,9}(\.\d{1,3})?$/;
const SPACES = /[\s  ]/g;
const CENTS = 100n;
const MILLIS = 1000n;

export function isZeroDecimalCurrency(currency: string | null | undefined): boolean {
  return ZERO_DECIMAL_CURRENCIES.has(currency ?? '');
}

export type MoneyInput = { readonly ok: true; readonly amount: string } | { readonly ok: false; readonly error: string };
export type QuantityInput = { readonly ok: true; readonly quantity: string } | { readonly ok: false; readonly error: string };

function groupThousands(integer: string): string {
  return integer.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
}

/** « 25 000 FCFA » ; devises sans subdivision (XOF, XAF, GNF, CDF) sans décimales ; autres devises : 2 décimales. */
export function formatMoney(amount: string | null | undefined, currency = 'XOF'): string {
  const match = amount ? DECIMAL.exec(amount) : null;
  if (!match) return '-';
  const [, sign = '', integer = '0', fraction = ''] = match;
  const label = CFA_CURRENCIES.has(currency) ? 'FCFA' : currency;
  if (isZeroDecimalCurrency(currency)) {
    const rounded = (fraction.charAt(0) >= '5' ? BigInt(integer) + 1n : BigInt(integer)).toString();
    return `${sign}${groupThousands(rounded)}${NBSP}${label}`;
  }
  const decimals = fraction.padEnd(2, '0').slice(0, 2);
  return `${sign}${groupThousands(integer)},${decimals}${NBSP}${label}`;
}

/** Saisie utilisateur (« 25 000 », « 1500,5 ») vers une chaîne API (« 25000.00 »). */
export function parseMoneyInput(raw: string, currency?: string): MoneyInput {
  const normalized = raw.replace(SPACES, '').replace(',', '.');
  if (isZeroDecimalCurrency(currency) && /\.\d*[1-9]/.test(normalized)) return { ok: false, error: ZERO_DECIMAL_ERROR };
  if (!INPUT_MONEY.test(normalized)) return { ok: false, error: 'Montant invalide : saisissez un nombre positif, par exemple 25 000.' };
  const [integer = '0', fraction = ''] = normalized.split('.');
  const scaled = isZeroDecimalCurrency(currency) ? '' : fraction;
  return { ok: true, amount: `${integer}.${scaled.padEnd(2, '0')}` };
}

export function parseQuantityInput(raw: string): QuantityInput {
  const normalized = raw.replace(SPACES, '').replace(',', '.');
  if (!INPUT_QUANTITY.test(normalized) || !/[1-9]/.test(normalized)) {
    return { ok: false, error: 'Quantité invalide : saisissez un nombre strictement positif.' };
  }
  return { ok: true, quantity: normalized };
}

function toCents(amount: string): bigint {
  const match = DECIMAL.exec(amount);
  if (!match) return 0n;
  const [, sign = '', integer = '0', fraction = ''] = match;
  const cents = BigInt(integer) * CENTS + BigInt(fraction.padEnd(2, '0').slice(0, 2));
  return sign === '-' ? -cents : cents;
}

function fromCents(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  return `${negative ? '-' : ''}${(abs / CENTS).toString()}.${(abs % CENTS).toString().padStart(2, '0')}`;
}

export function sumAmounts(amounts: readonly string[]): string {
  return fromCents(amounts.reduce((total, amount) => total + toCents(amount), 0n));
}

export function subtractAmounts(left: string, right: string): string {
  return fromCents(toCents(left) - toCents(right));
}

export function isPositiveAmount(amount: string): boolean {
  return DECIMAL.test(amount) && toCents(amount) > 0n;
}

/** Prix unitaire × quantité (3 décimales au plus), arrondi au centime (à l'unité pour les devises sans subdivision), moitié vers le haut. */
export function lineTotal(unitPrice: string, quantity: string, currency?: string): string {
  const match = DECIMAL.exec(quantity);
  if (!match) return '0.00';
  const [, , integer = '0', fraction = ''] = match;
  const millis = BigInt(integer) * MILLIS + BigInt(fraction.padEnd(3, '0').slice(0, 3));
  const product = toCents(unitPrice) * millis;
  if (isZeroDecimalCurrency(currency)) {
    const unit = MILLIS * CENTS;
    return fromCents(((product + unit / 2n) / unit) * CENTS);
  }
  return fromCents((product + MILLIS / 2n) / MILLIS);
}
