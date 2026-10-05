import { describe, expect, it } from 'vitest';
import { addBillingPeriod, addDays } from './period';

const d = (iso: string): Date => new Date(iso);

describe('addBillingPeriod', () => {
  it('ajoute un mois civil en UTC', () => {
    expect(addBillingPeriod(d('2026-10-04T10:00:00Z'), 'monthly')).toEqual(d('2026-11-04T10:00:00Z'));
  });

  it('ramène au dernier jour du mois quand le jour n’existe pas', () => {
    expect(addBillingPeriod(d('2026-01-31T00:00:00Z'), 'monthly')).toEqual(d('2026-02-28T00:00:00Z'));
    expect(addBillingPeriod(d('2028-01-31T00:00:00Z'), 'monthly')).toEqual(d('2028-02-29T00:00:00Z'));
  });

  it('passe l’année en décembre', () => {
    expect(addBillingPeriod(d('2026-12-15T00:00:00Z'), 'monthly')).toEqual(d('2027-01-15T00:00:00Z'));
  });

  it('ajoute un an et gère le 29 février', () => {
    expect(addBillingPeriod(d('2026-10-04T00:00:00Z'), 'yearly')).toEqual(d('2027-10-04T00:00:00Z'));
    expect(addBillingPeriod(d('2028-02-29T00:00:00Z'), 'yearly')).toEqual(d('2029-02-28T00:00:00Z'));
  });
});

describe('addDays', () => {
  it('ajoute des jours sans muter la date d’origine', () => {
    const origin = d('2026-10-04T00:00:00Z');
    expect(addDays(origin, 30)).toEqual(d('2026-11-03T00:00:00Z'));
    expect(origin).toEqual(d('2026-10-04T00:00:00Z'));
  });
});
