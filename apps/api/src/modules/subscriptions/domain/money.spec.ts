import { describe, expect, it } from 'vitest';
import { applyRate, fromMinor, prorate, toMinor } from './money';

describe('money (montants décimaux sans flottant)', () => {
  it('convertit une chaîne décimale en unités mineures et inversement', () => {
    expect(toMinor('25000.00')).toBe(2_500_000n);
    expect(toMinor('25000')).toBe(2_500_000n);
    expect(toMinor('0.5')).toBe(50n);
    expect(fromMinor(2_500_000n)).toBe('25000.00');
    expect(fromMinor(5n)).toBe('0.05');
    expect(fromMinor(0n)).toBe('0.00');
  });

  it('refuse un montant mal formé', () => {
    expect(() => toMinor('12,5')).toThrow();
    expect(() => toMinor('-1.00')).toThrow();
    expect(() => toMinor('1.234')).toThrow();
    expect(() => toMinor('')).toThrow();
  });

  it('accepte les montants numeric renvoyés par la base (ex. 75000.0000 non, 75000.00 oui)', () => {
    expect(toMinor('75000.00')).toBe(7_500_000n);
  });

  it('calcule une TVA arrondie à la demi-unité supérieure', () => {
    expect(applyRate(toMinor('25000.00'), '0.1800')).toBe(toMinor('4500.00'));
    // 33.33 × 18 % = 5.9994 → 6.00
    expect(applyRate(toMinor('33.33'), '0.1800')).toBe(toMinor('6.00'));
    // 0,05 × 19,25 % = 0,009625 → 0,01
    expect(applyRate(toMinor('0.05'), '0.1925')).toBe(1n);
    expect(applyRate(toMinor('100.00'), '0.0000')).toBe(0n);
  });

  it('proratise sans flottant, arrondi à la demi-unité supérieure', () => {
    // (75000 − 25000) × 10 j / 30 j = 16666,67
    expect(prorate(toMinor('50000.00'), 10, 30)).toBe(toMinor('16666.67'));
    expect(prorate(toMinor('50000.00'), 30, 30)).toBe(toMinor('50000.00'));
    expect(prorate(toMinor('50000.00'), 0, 30)).toBe(0n);
  });

  it('borne la proratisation au total de la période', () => {
    expect(prorate(toMinor('100.00'), 40, 30)).toBe(toMinor('100.00'));
    expect(() => prorate(100n, 1, 0)).toThrow();
  });
});
