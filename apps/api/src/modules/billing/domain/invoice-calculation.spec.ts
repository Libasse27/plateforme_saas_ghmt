import { describe, expect, it } from 'vitest';
import { formatMoney, parseMoney } from '../../../common/money/money';
import { computeLine, totalOfLines } from './invoice-calculation';

describe('calcul des lignes de facture', () => {
  it('calcule quantité × prix unitaire exactement', () => {
    const line = computeLine('3', parseMoney('1500.00'));

    expect(formatMoney(line.lineTotal)).toBe('4500.00');
  });

  it('arrondit le total de ligne à 2 décimales, moitié vers le haut', () => {
    expect(formatMoney(computeLine('0.5', parseMoney('0.05')).lineTotal)).toBe('0.03');
    expect(formatMoney(computeLine('1.333', parseMoney('10.00')).lineTotal)).toBe('13.33');
  });

  it('arrondit à l’unité pour une devise sans subdivision (moitié vers le haut)', () => {
    expect(formatMoney(computeLine('0.5', parseMoney('1001'), 0).lineTotal)).toBe('501.00');
    expect(formatMoney(computeLine('1.333', parseMoney('1000'), 0).lineTotal)).toBe('1333.00');
    expect(formatMoney(computeLine('0.4', parseMoney('1001'), 0).lineTotal)).toBe('400.00');
  });

  it('ne subit aucune erreur de flottant (0.1 × 3)', () => {
    expect(formatMoney(computeLine('3', parseMoney('0.10')).lineTotal)).toBe('0.30');
  });

  it('additionne les lignes en un sous-total exact', () => {
    const lines = [computeLine('1', parseMoney('0.10')), computeLine('1', parseMoney('0.20')), computeLine('2', parseMoney('1000.00'))];

    expect(formatMoney(totalOfLines(lines))).toBe('2000.30');
  });

  it('refuse une quantité nulle ou mal formée', () => {
    expect(() => computeLine('0', parseMoney('10'))).toThrow();
    expect(() => computeLine('1,5', parseMoney('10'))).toThrow();
    expect(() => computeLine('-1', parseMoney('10'))).toThrow();
  });
});
