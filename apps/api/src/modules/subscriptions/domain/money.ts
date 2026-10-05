/**
 * Montants décimaux en unités mineures (centimes) avec BigInt : jamais de flottant (docs/09 en-tête).
 * Les montants circulent en chaînes `"25000.00"` ; ce module convertit et calcule.
 */
const AMOUNT_PATTERN = /^(\d{1,16})(?:\.(\d{1,2}))?$/;
const MINOR_PER_UNIT = 100n;
const RATE_SCALE = 10_000n;
const RATE_PATTERN = /^(\d{1,2})(?:\.(\d{1,4}))?$/;

export function toMinor(amount: string): bigint {
  const match = AMOUNT_PATTERN.exec(amount);
  if (!match) throw new Error(`Montant invalide : « ${amount} »`);
  const cents = (match[2] ?? '').padEnd(2, '0');
  return BigInt(match[1]!) * MINOR_PER_UNIT + BigInt(cents);
}

export function fromMinor(minor: bigint): string {
  if (minor < 0n) throw new Error('Montant négatif');
  const units = minor / MINOR_PER_UNIT;
  const cents = (minor % MINOR_PER_UNIT).toString().padStart(2, '0');
  return `${units.toString()}.${cents}`;
}

/** Division entière arrondie à la demi-unité supérieure (opérandes positifs). */
function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

/** Montant de taxe : `minor × taux` (taux décimal `"0.1800"`), arrondi à la demi-unité supérieure. */
export function applyRate(minor: bigint, rate: string): bigint {
  const match = RATE_PATTERN.exec(rate);
  if (!match) throw new Error(`Taux invalide : « ${rate} »`);
  const scaled = BigInt(match[1]!) * RATE_SCALE + BigInt((match[2] ?? '').padEnd(4, '0'));
  return divRoundHalfUp(minor * scaled, RATE_SCALE);
}

/** `minor × remaining / total`, borné à `minor` (un reste supérieur au total ne dépasse jamais le montant plein). */
export function prorate(minor: bigint, remaining: number, total: number): bigint {
  if (!(total > 0)) throw new Error('Période totale invalide');
  const bounded = BigInt(Math.max(0, Math.min(Math.trunc(remaining), Math.trunc(total))));
  return divRoundHalfUp(minor * bounded, BigInt(Math.trunc(total)));
}
