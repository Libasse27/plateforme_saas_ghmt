import { describe, expect, it } from 'vitest';
import { appointmentSuppression, type AppointmentState } from './freshness';

const STARTS_AT = new Date('2026-10-08T14:00:00Z');
const VERSION = STARTS_AT.toISOString();
const live: AppointmentState = { status: 'scheduled', startsAt: STARTS_AT, deletedAt: null };

describe('appointmentSuppression : rappels (J-1, H-2)', () => {
  it.each(['appointment.reminder_d1', 'appointment.reminder_h2'] as const)('%s part pour un rendez-vous planifié ou confirmé à l’horaire prévu', (typeCode) => {
    expect(appointmentSuppression(typeCode, VERSION, live)).toBeNull();
    expect(appointmentSuppression(typeCode, VERSION, { ...live, status: 'confirmed' })).toBeNull();
  });

  it('supprime stale quand le rendez-vous a été déplacé (version différente)', () => {
    const moved = { ...live, startsAt: new Date('2026-10-09T14:00:00Z') };

    expect(appointmentSuppression('appointment.reminder_d1', VERSION, moved)).toBe('stale');
  });

  it('supprime appointment_cancelled pour un rendez-vous annulé ou supprimé', () => {
    expect(appointmentSuppression('appointment.reminder_h2', VERSION, { ...live, status: 'cancelled' })).toBe('appointment_cancelled');
    expect(appointmentSuppression('appointment.reminder_h2', VERSION, { ...live, deletedAt: new Date() })).toBe('appointment_cancelled');
  });

  it.each(['checked_in', 'in_progress', 'completed', 'no_show', 'requested'])('supprime stale quand le statut est %s (patient déjà arrivé, absent…)', (status) => {
    expect(appointmentSuppression('appointment.reminder_h2', VERSION, { ...live, status })).toBe('stale');
  });

  it('supprime stale quand le rendez-vous n’existe plus', () => {
    expect(appointmentSuppression('appointment.reminder_d1', VERSION, null)).toBe('stale');
  });
});

describe('appointmentSuppression : messages transactionnels', () => {
  it('la confirmation et le report ne partent pas pour un rendez-vous annulé ou supprimé', () => {
    for (const typeCode of ['appointment.confirmed', 'appointment.rescheduled'] as const) {
      expect(appointmentSuppression(typeCode, VERSION, { ...live, status: 'cancelled' })).toBe('appointment_cancelled');
      expect(appointmentSuppression(typeCode, VERSION, { ...live, deletedAt: new Date() })).toBe('appointment_cancelled');
    }
  });

  it('la confirmation et le report sont périmés (stale) si l’horaire a changé depuis : ils annonceraient une heure fausse', () => {
    const moved = { ...live, startsAt: new Date('2026-10-09T14:00:00Z') };

    expect(appointmentSuppression('appointment.confirmed', VERSION, moved)).toBe('stale');
    expect(appointmentSuppression('appointment.rescheduled', VERSION, moved)).toBe('stale');
    expect(appointmentSuppression('appointment.rescheduled', VERSION, live)).toBeNull();
  });

  it('l’avis d’annulation part pour un rendez-vous annulé', () => {
    expect(appointmentSuppression('appointment.cancelled', VERSION, { ...live, status: 'cancelled' })).toBeNull();
  });
});
