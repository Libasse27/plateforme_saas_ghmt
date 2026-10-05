import { describe, expect, it } from 'vitest';
import { DomainError } from '../errors/domain-error';
import { assertAmountScale } from './currency-scale';

describe('assertAmountScale', () => {
  it('refuse des décimales en XOF avec le code amount_scale (422)', () => {
    expect(() => assertAmountScale('1500.50', 'XOF', 'unitPrice')).toThrow(DomainError);
    try {
      assertAmountScale('1500.50', 'XOF', 'unitPrice');
    } catch (error) {
      expect(error).toMatchObject({ code: 'amount_scale', status: 422 });
    }
  });

  it('accepte un entier, ".00" et les devises à deux décimales', () => {
    expect(() => assertAmountScale('1500', 'XAF')).not.toThrow();
    expect(() => assertAmountScale('1500.00', 'GNF')).not.toThrow();
    expect(() => assertAmountScale('15.55', 'EUR')).not.toThrow();
  });
});
