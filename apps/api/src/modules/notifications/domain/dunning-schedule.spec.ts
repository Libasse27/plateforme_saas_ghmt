import { describe, expect, it } from 'vitest';
import { daysLate, dunningTypeFor, includesDirectors, latestReachedStep } from './dunning-schedule';

const OFFSETS = [-7, -3, 0, 3, 7, 12, 15];
const DUE_AT = new Date('2026-10-20T00:00:00Z');
const DAY = 86_400_000;
const at = (offsetDays: number, extraMs = 0): Date => new Date(DUE_AT.getTime() + offsetDays * DAY + extraMs);

describe('latestReachedStep', () => {
  it('ne renvoie rien avant la première étape', () => {
    expect(latestReachedStep(OFFSETS, DUE_AT, at(-8))).toBeNull();
  });

  it('renvoie la première étape à J-7 pile', () => {
    expect(latestReachedStep(OFFSETS, DUE_AT, at(-7))).toEqual({ offsetDays: -7, index: 0 });
  });

  it('ne renvoie que la dernière étape atteinte (pas de rattrapage en rafale)', () => {
    expect(latestReachedStep(OFFSETS, DUE_AT, at(8))).toEqual({ offsetDays: 7, index: 4 });
    expect(latestReachedStep(OFFSETS, DUE_AT, at(40))).toEqual({ offsetDays: 15, index: 6 });
  });

  it('reste sur l’étape courante tant que la suivante n’est pas atteinte', () => {
    expect(latestReachedStep(OFFSETS, DUE_AT, at(2, DAY - 1))).toEqual({ offsetDays: 0, index: 2 });
    expect(latestReachedStep(OFFSETS, DUE_AT, at(3))).toEqual({ offsetDays: 3, index: 3 });
  });

  it('accepte un calendrier personnalisé', () => {
    expect(latestReachedStep([0, 5], DUE_AT, at(1))).toEqual({ offsetDays: 0, index: 0 });
  });
});

describe('dunningTypeFor', () => {
  it('première étape : facture émise ; étapes ≤ 0 : rappel avant échéance', () => {
    expect(dunningTypeFor(0, OFFSETS)).toBe('subscription.invoice_issued');
    expect(dunningTypeFor(1, OFFSETS)).toBe('subscription.payment_reminder');
    expect(dunningTypeFor(2, OFFSETS)).toBe('subscription.payment_reminder');
  });

  it('étapes > 0 : retard ; dernière étape : avis de suspension', () => {
    expect(dunningTypeFor(3, OFFSETS)).toBe('subscription.payment_overdue');
    expect(dunningTypeFor(5, OFFSETS)).toBe('subscription.payment_overdue');
    expect(dunningTypeFor(6, OFFSETS)).toBe('subscription.suspension_notice');
  });

  it('une seule étape est la facture émise (la première prime sur la dernière)', () => {
    expect(dunningTypeFor(0, [0])).toBe('subscription.invoice_issued');
  });

  it('un calendrier d’étapes toutes positives commence par la facture émise', () => {
    expect(dunningTypeFor(0, [2, 4, 6])).toBe('subscription.invoice_issued');
    expect(dunningTypeFor(1, [2, 4, 6])).toBe('subscription.payment_overdue');
    expect(dunningTypeFor(2, [2, 4, 6])).toBe('subscription.suspension_notice');
  });
});

describe('includesDirectors', () => {
  it('ajoute les directeurs à partir de J+7', () => {
    expect(includesDirectors(3)).toBe(false);
    expect(includesDirectors(6)).toBe(false);
    expect(includesDirectors(7)).toBe(true);
    expect(includesDirectors(15)).toBe(true);
  });
});

describe('daysLate', () => {
  it('compte les jours entiers de retard, jamais négatif', () => {
    expect(daysLate(DUE_AT, at(-2))).toBe(0);
    expect(daysLate(DUE_AT, at(0))).toBe(0);
    expect(daysLate(DUE_AT, at(3, 3_600_000))).toBe(3);
    expect(daysLate(DUE_AT, at(12))).toBe(12);
  });
});
