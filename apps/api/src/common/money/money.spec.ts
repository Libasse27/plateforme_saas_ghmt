import { describe, expect, it } from 'vitest';
import { addMoney, formatMoney, isPositiveMoney, moneyEquals, parseMoney, roundMoney, subtractMoney } from './money';

describe('money (montants décimaux exacts)', () => {
  it('analyse une chaîne décimale et la reformate à 2 décimales', () => {
    expect(formatMoney(parseMoney('15000'))).toBe('15000.00');
    expect(formatMoney(parseMoney('0.1'))).toBe('0.10');
  });

  it('refuse une valeur qui n’est pas un montant décimal', () => {
    expect(() => parseMoney('1e3')).toThrow();
    expect(() => parseMoney('-5')).toThrow();
    expect(() => parseMoney('12,5')).toThrow();
    expect(() => parseMoney('1.234')).toThrow();
  });

  it('additionne sans erreur de flottant (0.1 + 0.2 = 0.30)', () => {
    expect(formatMoney(addMoney(parseMoney('0.1'), parseMoney('0.2')))).toBe('0.30');
  });

  it('soustrait et compare exactement', () => {
    expect(formatMoney(subtractMoney(parseMoney('100'), parseMoney('33.33')))).toBe('66.67');
    expect(moneyEquals(parseMoney('10'), parseMoney('10.00'))).toBe(true);
    expect(moneyEquals(parseMoney('10'), parseMoney('10.01'))).toBe(false);
  });

  it('arrondit à 2 décimales, moitié vers le haut', () => {
    expect(formatMoney(roundMoney(parseMoney('2.50').mul('1.005')))).toBe('2.51');
    expect(formatMoney(roundMoney(parseMoney('1').mul('0.125')))).toBe('0.13');
  });

  it('détecte un montant strictement positif', () => {
    expect(isPositiveMoney(parseMoney('0.01'))).toBe(true);
    expect(isPositiveMoney(parseMoney('0'))).toBe(false);
  });
});
