import { Prisma } from '../../../generated/prisma/client';
import { roundMoney, sumMoney, type Money } from '../../../common/money/money';

const QUANTITY_PATTERN = /^\d{1,9}(\.\d{1,3})?$/;

export interface ComputedLine {
  readonly quantity: Prisma.Decimal;
  readonly unitPrice: Money;
  readonly lineTotal: Money;
}

/**
 * Total de ligne = quantité × prix unitaire, arrondi à l'échelle de la devise : 2 décimales par défaut (contrainte SQL
 * `round(quantity * unit_price, 2)`), 0 pour XOF, XAF, GNF, CDF (le total entier reste égal à ce `round`).
 */
export function computeLine(quantity: string, unitPrice: Money, scale: 0 | 2 = 2): ComputedLine {
  if (!QUANTITY_PATTERN.test(quantity)) throw new Error('Quantité invalide');
  const parsed = new Prisma.Decimal(quantity);
  if (!parsed.greaterThan(0)) throw new Error('Quantité invalide');
  return { quantity: parsed, unitPrice, lineTotal: roundMoney(parsed.mul(unitPrice), scale) };
}

export function totalOfLines(lines: readonly ComputedLine[]): Money {
  return sumMoney(lines.map((line) => line.lineTotal));
}
