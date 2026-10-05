import { describe, expect, it } from 'vitest';
import { appointmentQuotaDecision, hardLimitViolation, planLimitReached, utcMonthBounds } from './entitlement-rules';

describe('hardLimitViolation (limites dures : utilisateurs, sites)', () => {
  it('autorise tant que la limite n’est pas atteinte', () => {
    expect(hardLimitViolation(5, 4)).toBeNull();
  });

  it('refuse quand l’effectif atteint la limite (ajouter un élément la dépasserait)', () => {
    expect(hardLimitViolation(5, 5)).toEqual({ limit: 5, current: 5 });
    expect(hardLimitViolation(5, 7)).toEqual({ limit: 5, current: 7 });
  });

  it('traite null comme illimité', () => {
    expect(hardLimitViolation(null, 1_000_000)).toBeNull();
  });

  it('une limite à 0 interdit tout ajout', () => {
    expect(hardLimitViolation(0, 0)).toEqual({ limit: 0, current: 0 });
  });
});

describe('appointmentQuotaDecision (limite souple, tolérance 120 %)', () => {
  it('ne limite jamais un plan illimité', () => {
    expect(appointmentQuotaDecision({ limit: null, current: 99_999, source: 'web' })).toBe('allowed');
  });

  it('autorise jusqu’à 120 % de la limite inclus pour toutes les sources', () => {
    // limite 500 ⇒ plafond 600 ; le 600e rendez-vous est accepté, le 601e refusé en ligne.
    expect(appointmentQuotaDecision({ limit: 500, current: 599, source: 'web' })).toBe('allowed');
    expect(appointmentQuotaDecision({ limit: 500, current: 600, source: 'web' })).toBe('refused');
    expect(appointmentQuotaDecision({ limit: 500, current: 600, source: 'mobile_app' })).toBe('refused');
  });

  it('ne bloque jamais le guichet ni le téléphone', () => {
    expect(appointmentQuotaDecision({ limit: 500, current: 10_000, source: 'front_desk' })).toBe('allowed');
    expect(appointmentQuotaDecision({ limit: 500, current: 10_000, source: 'phone' })).toBe('allowed');
  });

  it('gère les petites limites sans flottant', () => {
    // limite 5 ⇒ plafond 6
    expect(appointmentQuotaDecision({ limit: 5, current: 5, source: 'web' })).toBe('allowed');
    expect(appointmentQuotaDecision({ limit: 5, current: 6, source: 'web' })).toBe('refused');
  });
});

describe('planLimitReached', () => {
  it('produit un 403 plan_limit_reached avec le détail { limit, current }', () => {
    const error = planLimitReached('users', { limit: 5, current: 5 });
    expect(error.status).toBe(403);
    expect(error.code).toBe('plan_limit_reached');
    expect(error.extras.details).toEqual({ metric: 'users', limit: 5, current: 5 });
  });
});

describe('utcMonthBounds', () => {
  it('borne le mois civil UTC contenant la date', () => {
    const { start, end } = utcMonthBounds(new Date('2026-10-17T13:45:00Z'));
    expect(start).toEqual(new Date('2026-10-01T00:00:00Z'));
    expect(end).toEqual(new Date('2026-11-01T00:00:00Z'));
  });

  it('passe l’année en décembre et reste stable à la milliseconde près', () => {
    expect(utcMonthBounds(new Date('2026-12-31T23:59:59.999Z')).end).toEqual(new Date('2027-01-01T00:00:00Z'));
    expect(utcMonthBounds(new Date('2026-11-01T00:00:00.000Z')).start).toEqual(new Date('2026-11-01T00:00:00Z'));
  });
});
