import { describe, expect, it } from 'vitest';
import { Prisma } from '../../../generated/prisma/client';
import { toMethodTotals, toStatusCounts } from './dashboard.mapper';

describe('toStatusCounts', () => {
  it('renvoie les 8 statuts, zéros compris', () => {
    const counts = toStatusCounts(new Map([['scheduled', 3], ['cancelled', 1]]));

    expect(counts).toEqual({ requested: 0, scheduled: 3, confirmed: 0, checked_in: 0, in_progress: 0, completed: 0, cancelled: 1, no_show: 0 });
  });
});

describe('toMethodTotals', () => {
  it('somme exactement et formate à deux décimales, avec les 4 modes', () => {
    const totals = toMethodTotals(new Map([['cash', new Prisma.Decimal('0.10')], ['card', new Prisma.Decimal('0.20')]]));

    expect(totals).toEqual({ total: '0.30', byMethod: { cash: '0.10', mobile_money: '0.00', card: '0.20', other: '0.00' } });
  });

  it('renvoie des zéros sans aucun paiement', () => {
    expect(toMethodTotals(new Map())).toEqual({ total: '0.00', byMethod: { cash: '0.00', mobile_money: '0.00', card: '0.00', other: '0.00' } });
  });
});
