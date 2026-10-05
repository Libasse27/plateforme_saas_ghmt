import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlatformDb } from '../../src/infrastructure/prisma/platform-db.service';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { uuidv7 } from '../../src/modules/notifications/domain/uuid-v7';
import { NotificationRetentionJob } from '../../src/modules/notifications/jobs/notification-retention.job';
import { ReminderSweeperJob } from '../../src/modules/notifications/jobs/reminder-sweeper.job';
import { createTenantFixture, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { runDispatcher, sandboxOf } from './dispatch-fixtures';
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  bookAppointment,
  cancelAppointment,
  createClockOverrides,
  createPatientWithContacts,
  futureStart,
  notificationsOf,
  outboxOf,
  rebasePendingOutbox,
  recordConsent,
  utcAt,
} from './notification-fixtures';

describe('balayeur de rappels et rétention', () => {
  let app: INestApplication;
  let tenant: TenantFixture;
  let receptionist: UserFixture;
  let patientId: string;
  let dayOffset = 0;

  beforeAll(async () => {
    app = await createTestApp({}, { providerOverrides: createClockOverrides().overrides });
    tenant = await createTenantFixture(app, { prefix: 'jobs' });
    receptionist = await createUserWithRole(app, tenant, 'receptionist');
    patientId = await createPatientWithContacts(app, tenant);
    await recordConsent(app, tenant, patientId, 'sms');
  });

  afterAll(async () => {
    await app?.close();
  });

  const sweep = (now: Date) => app.get(ReminderSweeperJob).runOnce(now, { tenantIds: [tenant.tenantId] });
  const db = () => app.get(TenantDb);

  /** Rendez-vous planifié, relayé, puis rappels « perdus » (supprimés) pour simuler un événement manqué. */
  async function bookWithLostReminders(hour = 14): Promise<{ id: string; start: Date }> {
    dayOffset += 1;
    const start = futureStart(120 + dayOffset, hour);
    const taken = utcAt(start, -5, 11);
    const id = await bookAppointment(app, tenant, receptionist, { patientId, startsAt: start });
    await rebasePendingOutbox(app, tenant, taken);
    await runDispatcher(app, new Date(taken.getTime() + MINUTE_MS), tenant);
    await db().runAs(tenant.tenantId, (tx) => tx.notification.deleteMany({ where: { subjectId: id, category: 'clinical_reminder' } }));
    return { id, start };
  }

  describe('ReminderSweeperJob', () => {
    it('recrée les rappels attendus manquants encore à plus de 5 minutes, de façon idempotente', async () => {
      const { id, start } = await bookWithLostReminders();
      const now = new Date(start.getTime() - 20 * HOUR_MS);

      await sweep(now);
      await sweep(now);

      const reminders = await notificationsOf(app, tenant, { subjectId: id, category: 'clinical_reminder' });
      expect(reminders.map((r) => r.typeCode)).toEqual(['appointment.reminder_h2']);
      expect(reminders[0]).toMatchObject({ status: 'queued', channel: 'sms', scheduledAt: new Date(start.getTime() - 2 * HOUR_MS) });
    });

    it('recrée aussi le rappel J-1 quand son heure n’est pas encore passée', async () => {
      // RDV à 08:00 : J-1 (veille 10:00) tombe 22 h avant, donc dans l'horizon du balayeur.
      const { id, start } = await bookWithLostReminders(8);
      const now = new Date(start.getTime() - 25 * HOUR_MS);

      await sweep(now);

      const reminders = await notificationsOf(app, tenant, { subjectId: id, category: 'clinical_reminder' });
      expect(reminders.map((r) => r.typeCode).sort()).toEqual(['appointment.reminder_d1', 'appointment.reminder_h2']);
    });

    it('ne recrée pas un rappel dont l’envoi est à moins de 5 minutes', async () => {
      const { id, start } = await bookWithLostReminders();

      await sweep(new Date(start.getTime() - 2 * HOUR_MS - 4 * MINUTE_MS));

      expect(await notificationsOf(app, tenant, { subjectId: id, category: 'clinical_reminder' })).toHaveLength(0);
    });

    it('ignore les rendez-vous hors de l’horizon de 48 h, annulés, ou supprimés', async () => {
      const far = await bookWithLostReminders();
      const cancelled = await bookWithLostReminders();
      await cancelAppointment(app, receptionist, cancelled.id);

      await sweep(new Date(far.start.getTime() - 50 * HOUR_MS));
      await sweep(new Date(cancelled.start.getTime() - 20 * HOUR_MS));

      expect(await notificationsOf(app, tenant, { subjectId: far.id, category: 'clinical_reminder' })).toHaveLength(0);
      expect(await notificationsOf(app, tenant, { subjectId: cancelled.id, category: 'clinical_reminder' })).toHaveLength(0);
    });

    it('un rappel recréé est envoyé par le dispatcher à l’heure prévue', async () => {
      const { id, start } = await bookWithLostReminders();
      await sweep(new Date(start.getTime() - 20 * HOUR_MS));
      sandboxOf(app).clear();

      await runDispatcher(app, new Date(start.getTime() - 2 * HOUR_MS + MINUTE_MS), tenant);

      const [h2] = await notificationsOf(app, tenant, { subjectId: id, typeCode: 'appointment.reminder_h2' });
      expect(h2?.status).toBe('sent');
    });
  });

  describe('NotificationRetentionJob', () => {
    it('purge les messages in-app expirés, l’outbox traitée depuis plus de 30 jours et le routage STOP de plus de 180 jours', async () => {
      const retention = await createTenantFixture(app, { prefix: 'retention' });
      const now = new Date();
      await db().runAs(retention.tenantId, async (tx) => {
        for (const [title, expiresAt] of [['expiré', new Date(now.getTime() - DAY_MS)], ['valide', new Date(now.getTime() + DAY_MS)]] as const) {
          await tx.inAppMessage.create({ data: { id: uuidv7(), tenantId: retention.tenantId, userId: retention.adminUserId, typeCode: 'quota.sms_threshold', title, body: 'b', expiresAt } });
        }
        const old = new Date(now.getTime() - 31 * DAY_MS);
        const recent = new Date(now.getTime() - 10 * DAY_MS);
        const events: [string, 'processed' | 'pending', Date | null][] = [['old', 'processed', old], ['recent', 'processed', recent], ['pending', 'pending', null]];
        for (const [, status, processedAt] of events) {
          await tx.notificationOutboxEvent.create({ data: { tenantId: retention.tenantId, eventType: 'appointment.created', aggregateType: 'appointment', aggregateId: uuidv7(), payload: { startsAt: now.toISOString() }, status, processedAt, createdAt: old } });
        }
      });
      const phoneHmac = new Uint8Array(32).fill(9);
      await app.get(PlatformDb).run(async (tx) => {
        await tx.smsRecipientTenant.create({ data: { phoneHmac, tenantId: retention.tenantId, lastSentAt: new Date(now.getTime() - 200 * DAY_MS) } });
        await tx.smsRecipientTenant.create({ data: { phoneHmac: new Uint8Array(32).fill(8), tenantId: retention.tenantId, lastSentAt: new Date(now.getTime() - 10 * DAY_MS) } });
      });

      const report = await app.get(NotificationRetentionJob).runOnce(now, { tenantIds: [retention.tenantId] });

      expect(report).toMatchObject({ inappPurged: 1, outboxPurged: 1 });
      expect(report.routingPurged).toBeGreaterThanOrEqual(1);
      const messages = await db().runAs(retention.tenantId, (tx) => tx.inAppMessage.findMany({}));
      expect(messages.map((m) => m.title)).toEqual(['valide']);
      expect((await outboxOf(app, retention)).map((e) => e.status).sort()).toEqual(['pending', 'processed']);
      const routing = await app.get(PlatformDb).run((tx) => tx.smsRecipientTenant.findMany({ where: { tenantId: retention.tenantId } }));
      expect(routing).toHaveLength(1);
      expect(Buffer.from(routing[0]?.phoneHmac ?? []).readUInt8(0)).toBe(8);
    });
  });
});
