import { describe, expect, it } from 'vitest';
import {
  assertDeletable,
  assertPatientAlive,
  assertSlotNotInPast,
  assertTransitionTiming,
  localDateKey,
  requiresLivingPatient,
} from './appointment-rules';

const DAKAR = 'Africa/Dakar'; // UTC+0
const PARIS = 'Europe/Paris'; // UTC+1 ou +2
const NOON = new Date('2027-03-01T12:00:00Z');

describe('localDateKey', () => {
  it('donne le jour calendaire dans le fuseau demandé', () => {
    const lateEvening = new Date('2027-03-01T23:30:00Z');
    expect(localDateKey(lateEvening, DAKAR)).toBe('2027-03-01');
    expect(localDateKey(lateEvening, PARIS)).toBe('2027-03-02');
    expect(localDateKey(lateEvening, 'Pacific/Auckland')).toBe('2027-03-02');
  });
});

describe('assertTransitionTiming (A10)', () => {
  it('refuse no_show avant l’heure de début, l’accepte à l’heure et après', () => {
    const base = { startsAt: NOON, timeZone: DAKAR };
    expect(() => assertTransitionTiming('no_show', { ...base, now: new Date('2027-03-01T11:59:59Z') })).toThrowError(
      expect.objectContaining({ code: 'invalid_transition', status: 409 }),
    );
    expect(() => assertTransitionTiming('no_show', { ...base, now: NOON })).not.toThrow();
    expect(() => assertTransitionTiming('no_show', { ...base, now: new Date('2027-03-02T09:00:00Z') })).not.toThrow();
  });

  it('accepte checked_in le jour J, avant ou après l’heure, et le refuse la veille ou le lendemain', () => {
    const base = { startsAt: NOON, timeZone: DAKAR };
    expect(() => assertTransitionTiming('checked_in', { ...base, now: new Date('2027-03-01T06:00:00Z') })).not.toThrow();
    expect(() => assertTransitionTiming('checked_in', { ...base, now: new Date('2027-03-01T20:00:00Z') })).not.toThrow();
    for (const now of ['2027-02-28T23:59:00Z', '2027-03-02T00:00:00Z']) {
      expect(() => assertTransitionTiming('checked_in', { ...base, now: new Date(now) }), now).toThrowError(
        expect.objectContaining({ code: 'invalid_transition' }),
      );
    }
  });

  it('apprécie le jour J dans le fuseau du tenant, pas en UTC', () => {
    const startsAt = new Date('2027-03-01T23:30:00Z'); // 2 mars à Paris
    const now = new Date('2027-03-02T07:00:00Z'); // 2 mars à Paris, mais 2 mars aussi en UTC
    expect(() => assertTransitionTiming('checked_in', { now, startsAt, timeZone: PARIS })).not.toThrow();
    expect(() => assertTransitionTiming('checked_in', { now, startsAt, timeZone: DAKAR })).toThrow();
  });

  it('n’impose aucune contrainte horaire aux autres transitions', () => {
    for (const to of ['confirmed', 'cancelled', 'in_progress', 'completed'] as const) {
      expect(() => assertTransitionTiming(to, { now: new Date('2030-01-01T00:00:00Z'), startsAt: NOON, timeZone: DAKAR })).not.toThrow();
    }
  });
});

describe('assertDeletable (A10)', () => {
  it('autorise scheduled et confirmed seulement', () => {
    expect(() => assertDeletable('scheduled')).not.toThrow();
    expect(() => assertDeletable('confirmed')).not.toThrow();
    for (const status of ['requested', 'checked_in', 'in_progress', 'completed', 'cancelled', 'no_show'] as const) {
      expect(() => assertDeletable(status), status).toThrowError(expect.objectContaining({ code: 'invalid_transition', status: 409 }));
    }
  });
});

describe('créneau passé et patient décédé (A10)', () => {
  it('refuse un début dans le passé par 422 slot_in_past', () => {
    expect(() => assertSlotNotInPast(new Date('2027-03-01T11:00:00Z'), NOON)).toThrowError(expect.objectContaining({ code: 'slot_in_past', status: 422 }));
    expect(() => assertSlotNotInPast(NOON, NOON)).not.toThrow();
  });

  it('refuse un patient décédé par 422 patient_deceased', () => {
    expect(() => assertPatientAlive({ deceasedAt: NOON })).toThrowError(expect.objectContaining({ code: 'patient_deceased', status: 422 }));
    expect(() => assertPatientAlive({ deceasedAt: null })).not.toThrow();
  });

  it('réserve le contrôle du décès aux transitions de prise en charge', () => {
    expect(requiresLivingPatient('checked_in')).toBe(true);
    expect(requiresLivingPatient('confirmed')).toBe(true);
    expect(requiresLivingPatient('cancelled')).toBe(false);
    // Une consultation en cours doit pouvoir être poursuivie et clôturée même si le décès est enregistré entre-temps.
    expect(requiresLivingPatient('in_progress')).toBe(false);
    expect(requiresLivingPatient('completed')).toBe(false);
    expect(requiresLivingPatient('no_show')).toBe(false);
  });
});
