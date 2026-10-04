import { describe, expect, it } from 'vitest';
import { APPOINTMENT_STATUSES, type AppointmentStatus } from '@ghmt/shared';
import { allowedTransitions, assertTransition, canTransition } from './appointment-state-machine';

const VALID: ReadonlyArray<[AppointmentStatus, AppointmentStatus]> = [
  ['scheduled', 'confirmed'],
  ['scheduled', 'cancelled'],
  ['scheduled', 'no_show'],
  ['scheduled', 'checked_in'],
  ['confirmed', 'checked_in'],
  ['confirmed', 'cancelled'],
  ['confirmed', 'no_show'],
  ['checked_in', 'in_progress'],
  ['checked_in', 'cancelled'],
  ['in_progress', 'completed'],
];

describe('machine à états des rendez-vous', () => {
  it.each(VALID)('autorise %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it('refuse toute transition hors de la liste autorisée', () => {
    const invalid = APPOINTMENT_STATUSES.flatMap((from) => APPOINTMENT_STATUSES.map((to) => [from, to] as const)).filter(
      ([from, to]) => !VALID.some(([f, t]) => f === from && t === to),
    );
    expect(invalid.length).toBeGreaterThan(0);
    for (const [from, to] of invalid) expect(canTransition(from, to)).toBe(false);
  });

  it('considère completed, cancelled et no_show comme terminaux', () => {
    for (const status of ['completed', 'cancelled', 'no_show'] as const) expect(allowedTransitions(status)).toEqual([]);
  });

  it('lève une 409 invalid_transition pour une transition interdite', () => {
    expect(() => assertTransition('completed', 'scheduled')).toThrowError(
      expect.objectContaining({ code: 'invalid_transition', status: 409 }),
    );
  });
});
