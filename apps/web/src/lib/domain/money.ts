/**
 * Montants : chaînes décimales (« 25000.00 ») de bout en bout, jamais de flottant.
 * L'arithmétique passe par des entiers en centimes (BigInt).
 */
const NBSP = ' ';
const CFA_CURRENCIES: ReadonlySet<string> = new Set(['XOF', 'XAF']);
const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;
const INPUT_MONEY = /^\d{1,16}(\.\d{1,2})?$/;
const INPUT_QUANTITY = /^\d{1,9}(\.\d{1,3})?$/;
const SPACES = /[\s  ]/g;
const CENTS = 100n;
const MILLIS = 1000n;

export type MoneyInput = { readonly ok: true; readonly amount: string } | { readonly ok: false; readonly error: string };
export type QuantityInput = { readonly ok: true; readonly quantity: string } | { readonly ok: false; readonly error: string };

function groupThousands(integer: string): string {
  return integer.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
}

/** « 25 000 FCFA » ; francs CFA sans décimales sauf si elles sont non nulles ; autres devises : 2 décimales. */
export function formatMoney(amount: string | null | undefined, currency = 'XOF'): string {
  const match = amount ? DECIMAL.exec(amount) : null;
  if (!match) return '-';
  const [, sign = '', integer = '0', fraction = ''] = match;
  const cfa = CFA_CURRENCIES.has(currency);
  const decimals = cfa ? fraction.replace(/0+$/, '') : fraction.padEnd(2, '0').slice(0, 2);
  const body = `${groupThousands(integer)}${decimals ? `,${decimals.padEnd(cfa ? 2 : 0, '0')}` : ''}`;
  return `${sign}${body}${NBSP}${cfa ? 'FCFA' : currency}`;
}

/** Saisie utilisateur (« 25 000 », « 1500,5 ») vers une chaîne API (« 25000.00 »). */
export function parseMoneyInput(raw: string): MoneyInput {
  const normalized = raw.replace(SPACES, '').replace(',', '.');
  if (!INPUT_MONEY.test(normalized)) return { ok: false, error: 'Montant invalide : saisissez un nombre positif, par exemple 25 000.' };
  const [integer = '0', fraction = ''] = normalized.split('.');
  return { ok: true, amount: `${integer}.${fraction.padEnd(2, '0')}` };
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

/** Prix unitaire × quantité (3 décimales au plus), arrondi au centime (moitié vers le haut). */
export function lineTotal(unitPrice: string, quantity: string): string {
  const match = DECIMAL.exec(quantity);
  if (!match) return '0.00';
  const [, , integer = '0', fraction = ''] = match;
  const millis = BigInt(integer) * MILLIS + BigInt(fraction.padEnd(3, '0').slice(0, 3));
  const product = toCents(unitPrice) * millis;
  return fromCents((product + MILLIS / 2n) / MILLIS);
}
