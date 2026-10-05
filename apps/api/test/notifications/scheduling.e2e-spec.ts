import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTenantFixture, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { runDispatcher, sandboxOf } from './dispatch-fixtures';
import {
  HOUR_MS,
  PATIENT_PHONE,
  bookAppointment,
  cancelAppointment,
  createClockOverrides,
  createPatientWithContacts,
  findNotification,
  futureStart,
  notificationsOf,
  rebasePendingOutbox,
  recordConsent,
  replayOutbox,
  reschedule,
  setSiteTimezone,
  utcAt,
} from './notification-fixtures';

const START = futureStart(15, 14);
const TAKEN = utcAt(START, -5, 11);
const DAY = 24 * HOUR_MS;

describe('planification des notifications de rendez-vous', () => {
  let app: INestApplication;
  let tenant: TenantFixture;
  let receptionist: UserFixture;
  let patientId: string;

  beforeAll(async () => {
    const { overrides } = createClockOverrides();
    app = await createTestApp({}, { providerOverrides: overrides });
    tenant = await createTenantFixture(app, { prefix: 'plan' });
    receptionist = await createUserWithRole(app, tenant, 'receptionist');
    patientId = await createPatientWithContacts(app, tenant);
    await recordConsent(app, tenant, patientId, 'sms');
  });

  afterAll(async () => {
    await app?.close();
  });

  /** Prend un rendez-vous « à l'instant TAKEN » et lance une passe juste après. */
  async function bookAndRun(startsAt: Date, taken = TAKEN): Promise<string> {
    const id = await bookAppointment(app, tenant, receptionist, { patientId, startsAt });
    await rebasePendingOutbox(app, tenant, taken);
    await runDispatcher(app, new Date(taken.getTime() + 60_000), tenant);
    return id;
  }

  it('crée la confirmation (envoyée), le rappel J-1 et le rappel H-2 aux bonnes heures', async () => {
    const id = await bookAndRun(START);

    const rows = await notificationsOf(app, tenant, { subjectId: id });

    expect(rows.map((r) => r.typeCode).sort()).toEqual(['appointment.confirmed', 'appointment.reminder_d1', 'appointment.reminder_h2']);
    const confirmed = await findNotification(app, tenant, id, 'appointment.confirmed');
    const d1 = await findNotification(app, tenant, id, 'appointment.reminder_d1');
    const h2 = await findNotification(app, tenant, id, 'appointment.reminder_h2');
    expect(confirmed).toMatchObject({ channel: 'sms', status: 'sent', recipientType: 'patient', recipientId: patientId, subjectVersion: START.toISOString() });
    expect(d1).toMatchObject({ channel: 'sms', status: 'queued', subjectVersion: START.toISOString() });
    expect(d1.scheduledAt).toEqual(utcAt(START, -1, 10));
    expect(d1.deadlineAt).toEqual(new Date(START.getTime() - 2 * HOUR_MS));
    expect(h2.scheduledAt).toEqual(new Date(START.getTime() - 2 * HOUR_MS));
    expect(h2.deadlineAt).toEqual(new Date(START.getTime() - 30 * 60_000));
  });

  it('J-1 suit le fuseau du site du rendez-vous (Douala : 10:00 locale = 09:00 UTC)', async () => {
    await setSiteTimezone(app, tenant, tenant.mainSiteId, 'Africa/Douala');
    try {
      const id = await bookAndRun(futureStart(16, 14), utcAt(futureStart(16, 14), -5, 11));

      const d1 = await findNotification(app, tenant, id, 'appointment.reminder_d1');

      expect(d1.scheduledAt).toEqual(utcAt(futureStart(16, 14), -1, 9));
    } finally {
      await setSiteTimezone(app, tenant, tenant.mainSiteId, 'Africa/Dakar');
    }
  });

  it('rejouer un même événement ne crée aucun doublon ni second SMS', async () => {
    const start = futureStart(17, 14);
    const id = await bookAndRun(start, utcAt(start, -5, 11));
    const before = await notificationsOf(app, tenant, { subjectId: id });
    const sentBefore = sandboxOf(app).messages.length;

    await replayOutbox(app, tenant, id);
    await runDispatcher(app, new Date(utcAt(start, -5, 11).getTime() + 5 * 60_000), tenant);

    const after = await notificationsOf(app, tenant, { subjectId: id });
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(sandboxOf(app).messages).toHaveLength(sentBefore);
  });

  it('un report supprime les anciens rappels (stale) et en crée de nouveaux, avec un SMS de report', async () => {
    const start = futureStart(18, 14);
    const taken = utcAt(start, -5, 11);
    const id = await bookAndRun(start, taken);
    const next = new Date(start.getTime() + DAY);

    await reschedule(app, receptionist, id, next);
    const rescheduleAt = new Date(taken.getTime() + 3 * HOUR_MS);
    await rebasePendingOutbox(app, tenant, rescheduleAt);
    await runDispatcher(app, new Date(rescheduleAt.getTime() + 60_000), tenant);

    const rows = await notificationsOf(app, tenant, { subjectId: id });
    const reminders = rows.filter((r) => r.category === 'clinical_reminder');
    expect(reminders.filter((r) => r.subjectVersion === start.toISOString()).map((r) => [r.status, r.suppressionReason])).toEqual([
      ['suppressed', 'stale'],
      ['suppressed', 'stale'],
    ]);
    expect(reminders.filter((r) => r.subjectVersion === next.toISOString()).map((r) => r.status)).toEqual(['queued', 'queued']);
    const moved = await findNotification(app, tenant, id, 'appointment.rescheduled');
    expect(moved).toMatchObject({ status: 'sent', channel: 'sms', subjectVersion: next.toISOString() });
  });

  it('un retour à l’horaire initial réactive les rappels supprimés (stale)', async () => {
    const start = futureStart(19, 14);
    const taken = utcAt(start, -5, 11);
    const id = await bookAndRun(start, taken);
    const next = new Date(start.getTime() + DAY);
    await reschedule(app, receptionist, id, next);
    await rebasePendingOutbox(app, tenant, new Date(taken.getTime() + 3 * HOUR_MS));
    await runDispatcher(app, new Date(taken.getTime() + 3 * HOUR_MS + 60_000), tenant);

    await reschedule(app, receptionist, id, start);
    await rebasePendingOutbox(app, tenant, new Date(taken.getTime() + 6 * HOUR_MS));
    await runDispatcher(app, new Date(taken.getTime() + 6 * HOUR_MS + 60_000), tenant);

    const reminders = (await notificationsOf(app, tenant, { subjectId: id, category: 'clinical_reminder' }));
    const original = reminders.filter((r) => r.subjectVersion === start.toISOString());
    const intermediate = reminders.filter((r) => r.subjectVersion === next.toISOString());
    expect(original).toHaveLength(2);
    expect(original.every((r) => r.status === 'queued' && r.suppressionReason === null)).toBe(true);
    expect(intermediate.every((r) => r.status === 'suppressed' && r.suppressionReason === 'stale')).toBe(true);
  });

  it('une annulation supprime les rappels (appointment_cancelled) et envoie le SMS d’annulation', async () => {
    const start = futureStart(20, 14);
    const taken = utcAt(start, -5, 11);
    const id = await bookAndRun(start, taken);

    await cancelAppointment(app, receptionist, id);
    await rebasePendingOutbox(app, tenant, new Date(taken.getTime() + 2 * HOUR_MS));
    await runDispatcher(app, new Date(taken.getTime() + 2 * HOUR_MS + 60_000), tenant);

    const reminders = await notificationsOf(app, tenant, { subjectId: id, category: 'clinical_reminder' });
    expect(reminders.map((r) => [r.status, r.suppressionReason])).toEqual([
      ['suppressed', 'appointment_cancelled'],
      ['suppressed', 'appointment_cancelled'],
    ]);
    expect(await findNotification(app, tenant, id, 'appointment.cancelled')).toMatchObject({ status: 'sent', channel: 'sms' });
    const texts = sandboxOf(app).messages.map((m) => m.text);
    expect(texts.some((t) => t.includes('annulé'))).toBe(true);
  });

  it('un rendez-vous pris moins de 24 h puis moins de 3 h à l’avance n’a plus de J-1, puis plus de H-2', async () => {
    const lessThan24h = futureStart(21, 14);
    const lessThan3h = futureStart(22, 14);
    const a = await bookAppointment(app, tenant, receptionist, { patientId, startsAt: lessThan24h });
    await rebasePendingOutbox(app, tenant, new Date(lessThan24h.getTime() - 10 * HOUR_MS));
    await runDispatcher(app, new Date(lessThan24h.getTime() - 10 * HOUR_MS + 60_000), tenant);
    const b = await bookAppointment(app, tenant, receptionist, { patientId, startsAt: lessThan3h });
    await rebasePendingOutbox(app, tenant, new Date(lessThan3h.getTime() - 2 * HOUR_MS));
    await runDispatcher(app, new Date(lessThan3h.getTime() - 2 * HOUR_MS + 60_000), tenant);

    expect((await notificationsOf(app, tenant, { subjectId: a })).map((r) => r.typeCode).sort()).toEqual(['appointment.confirmed', 'appointment.reminder_h2']);
    expect((await notificationsOf(app, tenant, { subjectId: b })).map((r) => r.typeCode)).toEqual(['appointment.confirmed']);
  });

  it('ne planifie rien d’écrit en clair : ni numéro, ni nom, ni motif dans le journal', async () => {
    const start = futureStart(23, 14);
    const id = await bookAndRun(start, utcAt(start, -5, 11));

    const rows = await notificationsOf(app, tenant, { subjectId: id });
    const dump = JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

    expect(dump).not.toContain(PATIENT_PHONE.slice(1));
    expect(dump).not.toContain('VIH');
    expect(dump).not.toContain('Notif');
    expect(dump).not.toContain('Awa');
  });
});
