import type { INestApplication } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PlatformDb } from '../../src/infrastructure/prisma/platform-db.service';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { ConsentsRepository } from '../../src/modules/notifications/repositories/consents.repository';
import { DeliveryPreparer } from '../../src/modules/notifications/services/delivery-preparer';
import { SmsRecipientRegistry } from '../../src/modules/notifications/services/sms-recipient-registry';
import { ReminderSweeperJob } from '../../src/modules/notifications/jobs/reminder-sweeper.job';
import { createTenantFixture, createUserWithPermissions, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { runDispatcher, sandboxOf } from './dispatch-fixtures';
import {
  API,
  HOUR_MS,
  MINUTE_MS,
  PATIENT_PHONE,
  bearer,
  bookAppointment,
  createClockOverrides,
  createPatientWithContacts,
  findNotification,
  futureStart,
  http,
  notificationsOf,
  rebasePendingOutbox,
  recordConsent,
  reschedule,
  updateSettings,
  utcAt,
} from './notification-fixtures';

describe('correctifs des revues santé et sécurité', () => {
  let app: INestApplication;
  let tenant: TenantFixture;
  let receptionist: UserFixture;
  let day = 0;

  beforeAll(async () => {
    app = await createTestApp({}, { providerOverrides: createClockOverrides().overrides });
    tenant = await createTenantFixture(app, { prefix: 'review' });
    receptionist = await createUserWithRole(app, tenant, 'receptionist');
  });

  afterAll(async () => {
    await app?.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sandboxOf(app).clear();
  });

  const nextStart = (hour = 14): Date => futureStart(200 + (day += 1), hour);
  const takenOf = (start: Date): Date => utcAt(start, -5, 11);

  async function book(patientId: string, start = nextStart()): Promise<{ id: string; start: Date; taken: Date }> {
    const taken = takenOf(start);
    const id = await bookAppointment(app, tenant, receptionist, { patientId, startsAt: start });
    await rebasePendingOutbox(app, tenant, taken);
    return { id, start, taken };
  }
  const run = (now: Date) => runDispatcher(app, now, tenant);
  const settings = (token: string, body: unknown) => http(app).put(`${API}/notifications/settings`).set(bearer(token)).send(body as object);

  it('1. un report traité avant l’envoi supprime la confirmation périmée (stale), le message de report part', async () => {
    const patient = await createPatientWithContacts(app, tenant);
    const { id, start, taken } = await book(patient);
    await reschedule(app, receptionist, id, new Date(start.getTime() + 24 * HOUR_MS));
    await rebasePendingOutbox(app, tenant, taken);

    await run(new Date(taken.getTime() + MINUTE_MS));

    expect(await findNotification(app, tenant, id, 'appointment.confirmed')).toMatchObject({ status: 'suppressed', suppressionReason: 'stale' });
    expect(await findNotification(app, tenant, id, 'appointment.rescheduled')).toMatchObject({ status: 'sent' });
  });

  describe('2. rappel J-1 et plage silencieuse', () => {
    it('refuse une heure J-1 dans la plage silencieuse, y compris quand la plage change ensuite (422 invalid_reminder_time)', async () => {
      const direct = await settings(tenant.adminToken, { reminderD1LocalTime: '22:00' }).expect(422);
      const later = await settings(tenant.adminToken, { quietHoursStart: '09:00', quietHoursEnd: '11:00' }).expect(422);

      expect(direct.body.code).toBe('invalid_reminder_time');
      expect(later.body.code).toBe('invalid_reminder_time');
      await settings(tenant.adminToken, { reminderD1LocalTime: '10:00', quietHoursStart: '21:00', quietHoursEnd: '07:00' }).expect(200);
    });

    it('supprime le J-1 (too_late) quand il partirait le jour même du rendez-vous', async () => {
      const patient = await createPatientWithContacts(app, tenant);
      await recordConsent(app, tenant, patient, 'sms');
      const { id, start, taken } = await book(patient);
      await run(new Date(taken.getTime() + MINUTE_MS));

      await run(utcAt(start, 0, 7, 30));

      expect(await findNotification(app, tenant, id, 'appointment.reminder_d1')).toMatchObject({ status: 'suppressed', suppressionReason: expect.stringMatching(/too_late/) });
    });
  });

  describe('3. STOP durable', () => {
    it('répond 503 si un établissement échoue puis termine au rejeu (idempotent)', async () => {
      const phone = '+221770009001';
      const patient = await createPatientWithContacts(app, tenant, { phone });
      await recordConsent(app, tenant, patient, 'sms');
      const { taken } = await book(patient);
      await run(new Date(taken.getTime() + MINUTE_MS));
      vi.spyOn(app.get(ConsentsRepository), 'record').mockRejectedValueOnce(new Error('panne'));
      const send = () => http(app).post(`${API}/webhooks/sms/sandbox/inbound`).set('X-Forwarded-For', '10.88.0.1').send({ from: phone, text: 'STOP' });

      await send().expect(503);
      await send().expect(204);

      const stops = await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.patientContactConsent.findMany({ where: { patientId: patient, source: 'sms_stop' } }));
      expect(stops.length).toBeGreaterThanOrEqual(1);
    });

    it('un échec d’enregistrement du routage STOP reprogramme l’envoi sans envoyer le SMS', async () => {
      const patient = await createPatientWithContacts(app, tenant, { phone: '+221770009002' });
      const { id, taken } = await book(patient);
      vi.spyOn(app.get(SmsRecipientRegistry), 'touch').mockRejectedValueOnce(new Error('plateforme indisponible'));

      await run(new Date(taken.getTime() + MINUTE_MS));

      expect(sandboxOf(app).messages).toHaveLength(0);
      const row = await findNotification(app, tenant, id, 'appointment.confirmed');
      expect(row).toMatchObject({ status: 'queued', attempts: 1 });
      await run(row.nextAttemptAt);
      expect(sandboxOf(app).messages).toHaveLength(1);
    });
  });

  describe('4. noms affichés', () => {
    it('refuse un nom d’expéditeur ou de site contenant un terme interdit (422)', async () => {
      await settings(tenant.adminToken, { senderDisplayName: 'Service VIH' }).expect(422);
      await http(app).post(`${API}/org/sites`).set(bearer(tenant.adminToken)).send({ code: 'MAT', name: 'Maternité Nord' }).expect(422);
      const ok = await http(app).post(`${API}/org/sites`).set(bearer(tenant.adminToken)).send({ code: 'NORDOK', name: 'Site Nord' }).expect(201);
      await http(app).patch(`${API}/org/sites/${ok.body.data.id}`).set(bearer(tenant.adminToken)).set('If-Match', '"1"').send({ name: 'Pédiatrie et vaccin' }).expect(422);
    });

    it('au rendu, un nom existant non conforme retombe sur le nom de l’établissement', async () => {
      await updateSettings(app, tenant, { senderDisplayName: 'Clinique VIH' });
      const patient = await createPatientWithContacts(app, tenant);
      const { taken } = await book(patient);

      await run(new Date(taken.getTime() + MINUTE_MS));

      expect(sandboxOf(app).messages[0]?.text).not.toContain('VIH');
      await updateSettings(app, tenant, { senderDisplayName: null });
    });
  });

  describe('6 et 9. octroi d’un consentement', () => {
    it('replanifie les rappels du patient et supprime l’autre canal du même rappel', async () => {
      const patient = await createPatientWithContacts(app, tenant);
      await recordConsent(app, tenant, patient, 'email');
      const { id, taken } = await book(patient);
      await run(new Date(taken.getTime() + MINUTE_MS));
      expect((await notificationsOf(app, tenant, { subjectId: id, category: 'clinical_reminder' })).map((r) => [r.channel, r.status])).toEqual([['email', 'queued'], ['email', 'queued']]);

      await http(app).post(`${API}/patients/${patient}/contact-consents`).set(bearer(receptionist.token)).send({ channel: 'sms', purpose: 'appointment_reminder', granted: true, source: 'front_desk' }).expect(201);

      const reminders = await notificationsOf(app, tenant, { subjectId: id, category: 'clinical_reminder' });
      expect(reminders.filter((r) => r.status === 'queued').map((r) => r.channel)).toEqual(['sms', 'sms']);
      expect(reminders.filter((r) => r.channel === 'email').every((r) => r.status === 'suppressed')).toBe(true);
    });

    it('le balayeur couvre un horizon de 48 h', async () => {
      const patient = await createPatientWithContacts(app, tenant);
      await recordConsent(app, tenant, patient, 'sms');
      const { id, start, taken } = await book(patient);
      await run(new Date(taken.getTime() + MINUTE_MS));
      await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.notification.deleteMany({ where: { subjectId: id, category: 'clinical_reminder' } }));

      await app.get(ReminderSweeperJob).runOnce(new Date(start.getTime() - 40 * HOUR_MS), { tenantIds: [tenant.tenantId] });

      expect((await notificationsOf(app, tenant, { subjectId: id, category: 'clinical_reminder' })).length).toBeGreaterThan(0);
    });
  });

  it('7. un bail repris par un autre processus avant l’envoi abandonne l’envoi (aucun double SMS)', async () => {
    const patient = await createPatientWithContacts(app, tenant);
    const { taken } = await book(patient);
    const preparer = app.get(DeliveryPreparer);
    const original = preparer.prepare.bind(preparer);
    vi.spyOn(preparer, 'prepare').mockImplementation(async (tx, row, now) => {
      const prepared = await original(tx, row, now);
      await tx.notification.update({ where: { tenantId_id: { tenantId: row.tenantId, id: row.id } }, data: { lockedUntil: new Date(now.getTime() + 10 * HOUR_MS) } });
      return prepared;
    });

    await run(new Date(taken.getTime() + MINUTE_MS));

    expect(sandboxOf(app).messages).toHaveLength(0);
  });

  describe('8. STOP et SMS transactionnels', () => {
    it('après un STOP, la confirmation passe par e-mail et non par SMS (channel_disabled)', async () => {
      const phone = '+221770009003';
      const patient = await createPatientWithContacts(app, tenant, { phone });
      await recordConsent(app, tenant, patient, 'sms');
      const first = await book(patient);
      await run(new Date(first.taken.getTime() + MINUTE_MS));
      await http(app).post(`${API}/webhooks/sms/sandbox/inbound`).set('X-Forwarded-For', '10.88.0.2').send({ from: phone, text: 'STOP' }).expect(204);
      sandboxOf(app).clear();

      const second = await book(patient);
      await run(new Date(second.taken.getTime() + MINUTE_MS));

      expect(sandboxOf(app).messages.filter((m) => m.to === phone)).toHaveLength(0);
      const rows = await notificationsOf(app, tenant, { subjectId: second.id, typeCode: 'appointment.confirmed' });
      expect(rows.map((r) => [r.channel, r.status])).toEqual([['email', 'sent']]);
    });
  });

  it('10. la langue des messages patients suit la langue par défaut de l’établissement', async () => {
    const english = await createTenantFixture(app, { prefix: 'review-en' });
    const user = await createUserWithRole(app, english, 'receptionist');
    await app.get(PlatformDb).run((tx) => tx.tenant.update({ where: { id: english.tenantId }, data: { defaultLocale: 'en' } }));
    const patient = await createPatientWithContacts(app, english);
    const start = nextStart();
    const id = await bookAppointment(app, english, user, { patientId: patient, startsAt: start });
    await rebasePendingOutbox(app, english, takenOf(start));

    await runDispatcher(app, new Date(takenOf(start).getTime() + MINUTE_MS), english);

    expect(await findNotification(app, english, id, 'appointment.confirmed')).toMatchObject({ locale: 'en', status: 'sent' });
    expect(sandboxOf(app).messages.at(-1)?.text).toContain('appointment confirmed');
  });

  it('11. un changement de numéro réinitialise le consentement SMS et supprime les rappels SMS en attente', async () => {
    const patient = await createPatientWithContacts(app, tenant, { phone: '+221770009004' });
    await recordConsent(app, tenant, patient, 'sms');
    const { id, taken } = await book(patient);
    await run(new Date(taken.getTime() + MINUTE_MS));
    const editor = await createUserWithPermissions(app, tenant, ['patients:patient:read', 'patients:patient:update', 'patients:consent:read']);
    const detail = await http(app).get(`${API}/patients/${patient}`).set(bearer(editor.token)).expect(200);

    await http(app).patch(`${API}/patients/${patient}`).set(bearer(editor.token)).set('If-Match', `"${detail.body.data.rowVersion}"`).send({ phone: '+221770009005' }).expect(200);

    const consents = await http(app).get(`${API}/patients/${patient}/contact-consents`).set(bearer(editor.token)).expect(200);
    expect(consents.body.data.current[0]).toMatchObject({ channel: 'sms', granted: false, source: 'phone_change' });
    expect((await notificationsOf(app, tenant, { subjectId: id, category: 'clinical_reminder' })).every((r) => r.status === 'suppressed')).toBe(true);
    const audit = await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.auditLog.findFirst({ where: { action: 'patient.consent_changed', patientId: patient } }));
    expect(audit?.changes).toMatchObject({ source: 'phone_change', granted: false });
  });

  it('16. notification_due_tenants borne p_limit', async () => {
    const call = (limit: string) => app.get(TenantDb).runWithoutTenant((tx) => tx.$queryRawUnsafe<unknown[]>(`SELECT * FROM platform.notification_due_tenants(${limit})`));

    expect((await call('0')).length).toBeLessThanOrEqual(1);
    expect((await call('-5')).length).toBeLessThanOrEqual(1);
    expect((await call('1000000')).length).toBeLessThanOrEqual(500);
    expect(await call('NULL')).toBeInstanceOf(Array);
  });

  it('14. un lien in-app « // » est refusé par la base', async () => {
    await expect(
      app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.$executeRaw`INSERT INTO tenant.inapp_messages (id, tenant_id, user_id, type_code, title, body, link, expires_at) VALUES (gen_random_uuid(), ${tenant.tenantId}::uuid, ${tenant.adminUserId}::uuid, 'x', 't', 'b', '//evil.example/x', now())`),
    ).rejects.toThrow(/check|23514|violates/i);
    expect(PATIENT_PHONE).toBeDefined();
  });
});
