import { Prisma } from '../../../generated/prisma/client';
import { roundMoney, sumMoney, type Money } from '../../../common/money/money';

const QUANTITY_PATTERN = /^\d{1,9}(\.\d{1,3})?$/;

export interface ComputedLine {
  readonly quantity: Prisma.Decimal;
  readonly unitPrice: Money;
  readonly lineTotal: Money;
}

/** Total de ligne = quantité × prix unitaire, arrondi à 2 décimales (identique à la contrainte SQL `round(quantity * unit_price, 2)`). */
export function computeLine(quantity: string, unitPrice: Money): ComputedLine {
  if (!QUANTITY_PATTERN.test(quantity)) throw new Error('Quantité invalide');
  const parsed = new Prisma.Decimal(quantity);
  if (!parsed.greaterThan(0)) throw new Error('Quantité invalide');
  return { quantity: parsed, unitPrice, lineTotal: roundMoney(parsed.mul(unitPrice)) };
}

export function totalOfLines(lines: readonly ComputedLine[]): Money {
  return sumMoney(lines.map((line) => line.lineTotal));
}
