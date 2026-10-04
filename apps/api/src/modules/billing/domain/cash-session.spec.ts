import { describe, expect, it } from 'vitest';
import { formatMoney, parseMoney } from '../../../common/money/money';
import { cashVariance, expectedCashTotal, mayValidateSession } from './cash-session';

describe('caisse', () => {
  it('attendu = fond de caisse + espèces encaissées', () => {
    expect(formatMoney(expectedCashTotal(parseMoney('10000'), parseMoney('25000.50')))).toBe('35000.50');
  });

  it('écart = compté − attendu (négatif en cas de manque)', () => {
    expect(formatMoney(cashVariance(parseMoney('34000'), parseMoney('35000.50')))).toBe('-1000.50');
    expect(formatMoney(cashVariance(parseMoney('35000.50'), parseMoney('35000.50')))).toBe('0.00');
  });

  it('séparation des tâches : ni l’ouvreur ni le clôtureur ne valident', () => {
    expect(mayValidateSession({ openedBy: 'u1', closedBy: 'u2' }, 'u3')).toBe(true);
    expect(mayValidateSession({ openedBy: 'u1', closedBy: 'u2' }, 'u1')).toBe(false);
    expect(mayValidateSession({ openedBy: 'u1', closedBy: 'u2' }, 'u2')).toBe(false);
  });
});
