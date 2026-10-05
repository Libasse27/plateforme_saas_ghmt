import { describe, expect, it } from 'vitest';
import { parseMoney } from '../../../common/money/money';
import { balanceOf, statusAfterPayments } from './invoice-status';

const money = parseMoney;

describe('statut d’une facture selon les encaissements', () => {
  it('reste « issued » sans encaissement', () => {
    expect(statusAfterPayments(money('5000'), money('0'))).toBe('issued');
  });

  it('devient « partially_paid » dès un encaissement partiel', () => {
    expect(statusAfterPayments(money('5000'), money('0.01'))).toBe('partially_paid');
    expect(statusAfterPayments(money('5000'), money('4999.99'))).toBe('partially_paid');
  });

  it('devient « paid » quand le total est atteint ou dépassé', () => {
    expect(statusAfterPayments(money('5000'), money('5000'))).toBe('paid');
    expect(statusAfterPayments(money('5000'), money('5000.01'))).toBe('paid');
  });

  it('une facture à total nul est soldée', () => {
    expect(statusAfterPayments(money('0'), money('0'))).toBe('paid');
  });

  it('calcule le reste dû', () => {
    expect(balanceOf(money('5000'), money('1250.50')).toFixed(2)).toBe('3749.50');
  });
});
