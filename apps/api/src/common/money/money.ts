import { Prisma } from '../../generated/prisma/client';

/** Décimal exact (jamais de flottant) pour tous les montants : base `numeric(18,2)`, API en chaînes. */
export type Money = Prisma.Decimal;

const MONEY_PATTERN = /^\d{1,16}(\.\d{1,2})?$/;
const SCALE = 2;

/** Analyse un montant décimal en chaîne (`"15000"`, `"15000.50"`) ; toute autre forme est refusée. */
export function parseMoney(value: string): Money {
  if (!MONEY_PATTERN.test(value)) throw new Error('Montant invalide');
  return new Prisma.Decimal(value);
}

/** Représentation canonique de l'API : toujours 2 décimales. */
export function formatMoney(value: Money): string {
  return value.toFixed(SCALE);
}

/**
 * Arrondi commercial (moitié vers le haut), identique au `round()` de PostgreSQL pour les valeurs positives :
 * 2 décimales par défaut, 0 pour les devises sans subdivision (XOF, XAF, GNF, CDF).
 */
export function roundMoney(value: Money, scale: 0 | 2 = SCALE): Money {
  return value.toDecimalPlaces(scale, Prisma.Decimal.ROUND_HALF_UP);
}

export const zeroMoney = (): Money => new Prisma.Decimal(0);
export const addMoney = (a: Money, b: Money): Money => a.add(b);
export const subtractMoney = (a: Money, b: Money): Money => a.sub(b);
export const moneyEquals = (a: Money, b: Money): boolean => a.equals(b);
export const isPositiveMoney = (value: Money): boolean => value.greaterThan(0);

/** Somme exacte d'une liste de montants. */
export function sumMoney(values: readonly Money[]): Money {
  return values.reduce<Money>((total, value) => total.add(value), zeroMoney());
}
