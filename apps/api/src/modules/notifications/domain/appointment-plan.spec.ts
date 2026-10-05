import { describe, expect, it } from 'vitest';
import {
  D1_MIN_LEAD_MS,
  H2_MIN_LEAD_MS,
  chooseChannel,
  planAppointmentNotifications,
  planReminderTimes,
  reminderDeadline,
  type PlanInput,
  type PlanSettings,
} from './appointment-plan';

const HOUR = 3_600_000;
const SETTINGS: PlanSettings = { appointmentSmsEnabled: true, reminderD1Enabled: true, reminderD1LocalTime: '10:00', reminderH2Enabled: true };
const FULL_CONTACT = { hasPhone: true, hasEmail: true, smsConsent: true, emailConsent: true };
const STARTS_AT = new Date('2026-10-08T14:00:00Z');
const TAKEN_AT = new Date('2026-10-05T09:00:00Z');

function input(patch: Partial<PlanInput> = {}): PlanInput {
  return {
    eventType: 'appointment.created',
    eventId: 'evt-1',
    appointmentId: 'apt-1',
    startsAt: STARTS_AT,
    takenAt: TAKEN_AT,
    timeZone: 'Africa/Dakar',
    settings: SETTINGS,
    contact: FULL_CONTACT,
    ...patch,
  };
}

describe('planReminderTimes', () => {
  it('J-1 : la veille à l’heure locale réglée ; H-2 : 2 h avant', () => {
    const times = planReminderTimes({ startsAt: STARTS_AT, takenAt: TAKEN_AT, timeZone: 'Africa/Dakar', settings: SETTINGS });

    expect(times.d1?.toISOString()).toBe('2026-10-07T10:00:00.000Z');
    expect(times.h2?.toISOString()).toBe('2026-10-08T12:00:00.000Z');
  });

  it('applique le fuseau local du site pour J-1 (Douala 10:00 locale = 09:00 UTC)', () => {
    const times = planReminderTimes({ startsAt: STARTS_AT, takenAt: TAKEN_AT, timeZone: 'Africa/Douala', settings: SETTINGS });

    expect(times.d1?.toISOString()).toBe('2026-10-07T09:00:00.000Z');
  });

  it('J-1 est la veille LOCALE même si l’instant UTC tombe un autre jour (Lubumbashi, RDV 00:30 locale)', () => {
    // 2026-10-08T22:30Z = 2026-10-09 00:30 à Lubumbashi → la veille locale est le 8 octobre à 10:00 locale (08:00 UTC).
    const times = planReminderTimes({ startsAt: new Date('2026-10-08T22:30:00Z'), takenAt: TAKEN_AT, timeZone: 'Africa/Lubumbashi', settings: SETTINGS });

    expect(times.d1?.toISOString()).toBe('2026-10-08T08:00:00.000Z');
  });

  it('ne planifie pas J-1 quand le RDV est pris moins de 24 h à l’avance, mais l’autorise avec plus de 24 h d’avance', () => {
    const tooClose = planReminderTimes({ startsAt: STARTS_AT, takenAt: new Date(STARTS_AT.getTime() - D1_MIN_LEAD_MS + 1), timeZone: 'Africa/Dakar', settings: SETTINGS });
    const longLead = planReminderTimes({ startsAt: STARTS_AT, takenAt: new Date(STARTS_AT.getTime() - D1_MIN_LEAD_MS - 20 * HOUR), timeZone: 'Africa/Dakar', settings: SETTINGS });

    expect(tooClose.d1).toBeNull();
    expect(longLead.d1).not.toBeNull();
  });

  it('ne planifie pas H-2 quand le RDV est pris moins de 3 h à l’avance, mais l’autorise à 3 h pile', () => {
    const tooClose = planReminderTimes({ startsAt: STARTS_AT, takenAt: new Date(STARTS_AT.getTime() - H2_MIN_LEAD_MS + 1), timeZone: 'Africa/Dakar', settings: SETTINGS });
    const exactly = planReminderTimes({ startsAt: STARTS_AT, takenAt: new Date(STARTS_AT.getTime() - H2_MIN_LEAD_MS), timeZone: 'Africa/Dakar', settings: SETTINGS });

    expect(tooClose.h2).toBeNull();
    expect(exactly.h2?.toISOString()).toBe('2026-10-08T12:00:00.000Z');
  });

  it('ne planifie pas un J-1 déjà passé au moment de la prise (RDV demain 11:00 pris à 10:30, 24,5 h avant)', () => {
    const times = planReminderTimes({
      startsAt: new Date('2026-10-08T11:00:00Z'),
      takenAt: new Date('2026-10-07T10:30:00Z'),
      timeZone: 'Africa/Dakar',
      settings: SETTINGS,
    });

    expect(times.d1).toBeNull();
  });

  it('respecte les interrupteurs reminder_d1_enabled et reminder_h2_enabled', () => {
    const none = planReminderTimes({
      startsAt: STARTS_AT,
      takenAt: TAKEN_AT,
      timeZone: 'Africa/Dakar',
      settings: { ...SETTINGS, reminderD1Enabled: false, reminderH2Enabled: false },
    });

    expect(none).toEqual({ d1: null, h2: null });
  });
});

describe('reminderDeadline', () => {
  it('J-1 : 2 h avant le RDV ; H-2 : 30 min avant', () => {
    expect(reminderDeadline('appointment.reminder_d1', STARTS_AT).toISOString()).toBe('2026-10-08T12:00:00.000Z');
    expect(reminderDeadline('appointment.reminder_h2', STARTS_AT).toISOString()).toBe('2026-10-08T13:30:00.000Z');
  });
});

describe('chooseChannel : rappels (consentement explicite par canal)', () => {
  it('SMS quand le téléphone et le consentement SMS existent', () => {
    expect(chooseChannel('clinical_reminder', FULL_CONTACT, SETTINGS)).toEqual({ channel: 'sms', suppressionReason: null });
  });

  it('e-mail quand le SMS n’est pas consenti mais l’e-mail l’est', () => {
    const contact = { ...FULL_CONTACT, smsConsent: false };

    expect(chooseChannel('clinical_reminder', contact, SETTINGS)).toEqual({ channel: 'email', suppressionReason: null });
  });

  it('ligne supprimée no_consent quand le contact existe sans consentement', () => {
    const contact = { hasPhone: true, hasEmail: true, smsConsent: false, emailConsent: false };

    expect(chooseChannel('clinical_reminder', contact, SETTINGS)).toEqual({ channel: 'sms', suppressionReason: 'no_consent' });
  });

  it('ligne supprimée no_contact sans téléphone ni e-mail', () => {
    const contact = { hasPhone: false, hasEmail: false, smsConsent: true, emailConsent: true };

    expect(chooseChannel('clinical_reminder', contact, SETTINGS)).toEqual({ channel: 'sms', suppressionReason: 'no_contact' });
  });

  it('un e-mail sans consentement ne suffit pas quand il est le seul contact : no_consent sur le canal e-mail', () => {
    const contact = { hasPhone: false, hasEmail: true, smsConsent: false, emailConsent: false };

    expect(chooseChannel('clinical_reminder', contact, SETTINGS)).toEqual({ channel: 'email', suppressionReason: 'no_consent' });
  });
});

describe('chooseChannel : messages transactionnels', () => {
  it('SMS avec téléphone et appointment_sms_enabled, sans exiger de consentement', () => {
    const contact = { hasPhone: true, hasEmail: false, smsConsent: false, emailConsent: false };

    expect(chooseChannel('transactional', contact, SETTINGS)).toEqual({ channel: 'sms', suppressionReason: null });
  });

  it('e-mail quand les SMS sont désactivés', () => {
    expect(chooseChannel('transactional', FULL_CONTACT, { ...SETTINGS, appointmentSmsEnabled: false })).toEqual({ channel: 'email', suppressionReason: null });
  });

  it('channel_disabled quand seuls les SMS sont possibles mais désactivés', () => {
    const contact = { hasPhone: true, hasEmail: false, smsConsent: false, emailConsent: false };

    expect(chooseChannel('transactional', contact, { ...SETTINGS, appointmentSmsEnabled: false })).toEqual({ channel: 'sms', suppressionReason: 'channel_disabled' });
  });

  it('no_contact sans téléphone ni e-mail', () => {
    const contact = { hasPhone: false, hasEmail: false, smsConsent: false, emailConsent: false };

    expect(chooseChannel('transactional', contact, SETTINGS)).toEqual({ channel: 'sms', suppressionReason: 'no_contact' });
  });
});

describe('planAppointmentNotifications', () => {
  it('appointment.created : confirmation immédiate + rappels J-1 et H-2', () => {
    const plan = planAppointmentNotifications(input());

    expect(plan.map((p) => p.typeCode)).toEqual(['appointment.confirmed', 'appointment.reminder_d1', 'appointment.reminder_h2']);
    const [confirmed, d1, h2] = plan;
    expect(confirmed).toMatchObject({ sourceKey: 'evt-1', variant: '', channel: 'sms', suppressionReason: null });
    expect(confirmed?.scheduledAt).toEqual(TAKEN_AT);
    expect(d1).toMatchObject({ sourceKey: 'apt-1', variant: STARTS_AT.toISOString(), subjectVersion: STARTS_AT.toISOString() });
    expect(d1?.scheduledAt.toISOString()).toBe('2026-10-07T10:00:00.000Z');
    expect(h2?.scheduledAt.toISOString()).toBe('2026-10-08T12:00:00.000Z');
  });

  it('applique les échéances : SMS immédiat création + 2 h, e-mail création + 24 h, rappels liés à l’heure du RDV', () => {
    const [confirmed, d1, h2] = planAppointmentNotifications(input());
    const emailPlan = planAppointmentNotifications(input({ contact: { ...FULL_CONTACT, hasPhone: false } }));

    expect(confirmed?.deadlineAt?.toISOString()).toBe('2026-10-05T11:00:00.000Z');
    expect(emailPlan[0]?.deadlineAt?.toISOString()).toBe('2026-10-06T09:00:00.000Z');
    expect(d1?.deadlineAt?.toISOString()).toBe('2026-10-08T12:00:00.000Z');
    expect(h2?.deadlineAt?.toISOString()).toBe('2026-10-08T13:30:00.000Z');
  });

  it('RDV pris moins de 24 h puis moins de 3 h à l’avance : confirmation seule, puis confirmation et J-1 absents', () => {
    const lessThan24h = planAppointmentNotifications(input({ takenAt: new Date(STARTS_AT.getTime() - 10 * HOUR) }));
    const lessThan3h = planAppointmentNotifications(input({ takenAt: new Date(STARTS_AT.getTime() - 2 * HOUR) }));

    expect(lessThan24h.map((p) => p.typeCode)).toEqual(['appointment.confirmed', 'appointment.reminder_h2']);
    expect(lessThan3h.map((p) => p.typeCode)).toEqual(['appointment.confirmed']);
  });

  it('appointment.rescheduled : message de report + nouveaux rappels', () => {
    const plan = planAppointmentNotifications(input({ eventType: 'appointment.rescheduled', eventId: 'evt-2' }));

    expect(plan.map((p) => p.typeCode)).toEqual(['appointment.rescheduled', 'appointment.reminder_d1', 'appointment.reminder_h2']);
    expect(plan[0]?.sourceKey).toBe('evt-2');
  });

  it('appointment.cancelled : message d’annulation seul, sans rappel', () => {
    const plan = planAppointmentNotifications(input({ eventType: 'appointment.cancelled' }));

    expect(plan.map((p) => p.typeCode)).toEqual(['appointment.cancelled']);
  });

  it('appointment.deleted : aucun message (correction de saisie)', () => {
    expect(planAppointmentNotifications(input({ eventType: 'appointment.deleted' }))).toEqual([]);
  });

  it('rejouer le même événement produit exactement le même plan (clés de déduplication stables)', () => {
    expect(planAppointmentNotifications(input())).toEqual(planAppointmentNotifications(input()));
  });

  it('un contact sans consentement donne des rappels supprimés no_consent mais une confirmation envoyée', () => {
    const contact = { hasPhone: true, hasEmail: false, smsConsent: false, emailConsent: false };
    const plan = planAppointmentNotifications(input({ contact }));

    expect(plan.map((p) => p.suppressionReason)).toEqual([null, 'no_consent', 'no_consent']);
  });

  it('marque tout supprimé recipient_inactive pour un patient décédé', () => {
    const plan = planAppointmentNotifications(input({ deceased: true }));

    expect(plan.length).toBeGreaterThan(0);
    expect(plan.every((p) => p.suppressionReason === 'recipient_inactive')).toBe(true);
  });
});
