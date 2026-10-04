import { describe, expect, it } from 'vitest';
import { formatMoney, isPositiveAmount, lineTotal, parseMoneyInput, parseQuantityInput, sumAmounts, subtractAmounts } from './money';

const NBSP = ' ';

describe('formatMoney', () => {
  it('formate les francs CFA avec séparateur de milliers insécable et suffixe FCFA', () => {
    expect(formatMoney('25000.00', 'XOF')).toBe(`25${NBSP}000${NBSP}FCFA`);
    expect(formatMoney('1250000', 'XAF')).toBe(`1${NBSP}250${NBSP}000${NBSP}FCFA`);
    expect(formatMoney('0.00', 'XOF')).toBe(`0${NBSP}FCFA`);
  });
  it('conserve les décimales non nulles pour le franc CFA', () => {
    expect(formatMoney('1500.50', 'XOF')).toBe(`1${NBSP}500,50${NBSP}FCFA`);
  });
  it('affiche toujours deux décimales pour les autres devises', () => {
    expect(formatMoney('12', 'EUR')).toBe(`12,00${NBSP}EUR`);
    expect(formatMoney('1234.5', 'USD')).toBe(`1${NBSP}234,50${NBSP}USD`);
  });
  it('gère les montants négatifs (écart de caisse)', () => {
    expect(formatMoney('-1500.00', 'XOF')).toBe(`-1${NBSP}500${NBSP}FCFA`);
  });
  it('utilise XOF par défaut et renvoie un tiret pour une valeur absente ou invalide', () => {
    expect(formatMoney('100')).toBe(`100${NBSP}FCFA`);
    expect(formatMoney(null)).toBe('-');
    expect(formatMoney(undefined)).toBe('-');
    expect(formatMoney('abc')).toBe('-');
  });
});

describe('parseMoneyInput', () => {
  it('normalise espaces, virgule et décimales', () => {
    expect(parseMoneyInput('25 000')).toEqual({ ok: true, amount: '25000.00' });
    expect(parseMoneyInput(`25${NBSP}000,5`)).toEqual({ ok: true, amount: '25000.50' });
    expect(parseMoneyInput('0')).toEqual({ ok: true, amount: '0.00' });
  });
  it('refuse vide, négatif, trop de décimales et texte', () => {
    for (const raw of ['', '  ', '-5', '1.234', 'abc', '1e5', '12345678901234567']) {
      expect(parseMoneyInput(raw).ok).toBe(false);
    }
  });
});

describe('parseQuantityInput', () => {
  it('accepte entiers et décimales (3 max) strictement positifs', () => {
    expect(parseQuantityInput('2')).toEqual({ ok: true, quantity: '2' });
    expect(parseQuantityInput('0,5')).toEqual({ ok: true, quantity: '0.5' });
  });
  it('refuse zéro, négatif et trop de décimales', () => {
    for (const raw of ['', '0', '0.000', '-1', '1.2345', 'x']) expect(parseQuantityInput(raw).ok).toBe(false);
  });
});

describe('arithmétique décimale', () => {
  it('additionne et soustrait sans flottant', () => {
    expect(sumAmounts(['0.10', '0.20'])).toBe('0.30');
    expect(sumAmounts([])).toBe('0.00');
    expect(subtractAmounts('100.00', '25000.50')).toBe('-24900.50');
  });
  it('calcule le total de ligne avec arrondi au centime supérieur à partir de .5', () => {
    expect(lineTotal('25000.00', '2')).toBe('50000.00');
    expect(lineTotal('1000.00', '0.5')).toBe('500.00');
    expect(lineTotal('0.01', '0.5')).toBe('0.01');
    expect(lineTotal('0.01', '0.4')).toBe('0.00');
  });
  it('détecte un montant strictement positif', () => {
    expect(isPositiveAmount('0.01')).toBe(true);
    expect(isPositiveAmount('0.00')).toBe(false);
    expect(isPositiveAmount('-1.00')).toBe(false);
    expect(isPositiveAmount('x')).toBe(false);
  });
});
