import { describe, expect, it } from 'vitest';
import { decideEarly, type DecisionInput } from './delivery-decision';

const NOW = new Date('2026-10-07T10:00:00Z');
const STARTS_AT = new Date('2026-10-08T14:00:00Z');

const reminder: DecisionInput = {
  now: NOW,
  typeCode: 'appointment.reminder_d1',
  category: 'clinical_reminder',
  channel: 'sms',
  deadlineAt: new Date('2026-10-08T12:00:00Z'),
  subjectVersion: STARTS_AT.toISOString(),
  appointment: { status: 'scheduled', startsAt: STARTS_AT, deletedAt: null },
  expectsAppointment: true,
  recipientActive: true,
  address: '+221771234545',
  consentGranted: true,
  emailPreferenceEnabled: true,
  appointmentSmsEnabled: true,
};

describe('decideEarly', () => {
  it('laisse passer un rappel frais, consenti, avec une adresse', () => {
    expect(decideEarly(reminder)).toBeNull();
  });

  it('supprime un rappel périmé (rendez-vous déplacé, annulé, déjà arrivé)', () => {
    expect(decideEarly({ ...reminder, appointment: { ...reminder.appointment!, startsAt: new Date('2026-10-09T14:00:00Z') } })).toEqual({ kind: 'suppress', reason: 'stale' });
    expect(decideEarly({ ...reminder, appointment: { ...reminder.appointment!, status: 'cancelled' } })).toEqual({ kind: 'suppress', reason: 'appointment_cancelled' });
    expect(decideEarly({ ...reminder, appointment: { ...reminder.appointment!, status: 'checked_in' } })).toEqual({ kind: 'suppress', reason: 'stale' });
  });

  it('supprime recipient_inactive pour un destinataire inactif', () => {
    expect(decideEarly({ ...reminder, recipientActive: false })).toEqual({ kind: 'suppress', reason: 'recipient_inactive' });
  });

  it('échoue en deadline_exceeded au-delà de l’échéance', () => {
    const outcome = decideEarly({ ...reminder, now: new Date('2026-10-08T12:00:01Z') });

    expect(outcome).toEqual({ kind: 'fail', errorCode: 'deadline_exceeded', errorClass: null });
  });

  it('une échéance exactement atteinte n’est pas dépassée', () => {
    expect(decideEarly({ ...reminder, now: new Date('2026-10-08T12:00:00Z') })).toBeNull();
  });

  it('supprime no_contact quand l’adresse manque', () => {
    expect(decideEarly({ ...reminder, address: null })).toEqual({ kind: 'suppress', reason: 'no_contact' });
  });

  it('exige le consentement pour un rappel, mais pas pour un message transactionnel', () => {
    expect(decideEarly({ ...reminder, consentGranted: false })).toEqual({ kind: 'suppress', reason: 'no_consent' });
    const confirmation: DecisionInput = { ...reminder, typeCode: 'appointment.confirmed', category: 'transactional', consentGranted: false };
    expect(decideEarly(confirmation)).toBeNull();
  });

  it('respecte appointmentSmsEnabled pour un SMS transactionnel (channel_disabled)', () => {
    const confirmation: DecisionInput = { ...reminder, typeCode: 'appointment.confirmed', category: 'transactional', appointmentSmsEnabled: false };

    expect(decideEarly(confirmation)).toEqual({ kind: 'suppress', reason: 'channel_disabled' });
    expect(decideEarly({ ...confirmation, channel: 'email' })).toBeNull();
  });

  describe('préférences du personnel (e-mail administratif)', () => {
    const admin: DecisionInput = {
      ...reminder,
      typeCode: 'quota.sms_threshold',
      category: 'administrative',
      channel: 'email',
      deadlineAt: null,
      subjectVersion: null,
      appointment: null,
      expectsAppointment: false,
      address: 'admin@clinique.sn',
    };

    it('supprime preference_disabled quand l’e-mail est désactivé', () => {
      expect(decideEarly({ ...admin, emailPreferenceEnabled: false })).toEqual({ kind: 'suppress', reason: 'preference_disabled' });
    });

    it('ignore la préférence pour les relances d’abonnement (subscription.*)', () => {
      expect(decideEarly({ ...admin, typeCode: 'subscription.payment_overdue', emailPreferenceEnabled: false })).toBeNull();
    });

    it('ne s’applique pas à l’in-app (toujours actif)', () => {
      expect(decideEarly({ ...admin, channel: 'inapp', emailPreferenceEnabled: false })).toBeNull();
    });
  });
});
