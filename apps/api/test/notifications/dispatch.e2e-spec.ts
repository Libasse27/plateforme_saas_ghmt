import { Logger, type INestApplication } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAILER } from '../../src/common/mail/mailer';
import { MemoryMailer } from '../../src/common/mail/memory-mailer';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { SmsProviderError } from '../../src/modules/notifications/providers/sms-provider';
import { createTenantFixture, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { runDispatcher, sandboxOf } from './dispatch-fixtures';
import {
  HOUR_MS,
  MINUTE_MS,
  PATIENT_EMAIL,
  PATIENT_PHONE,
  SECRET_REASON,
  bookAppointment,
  createClockOverrides,
  createPatientWithContacts,
  findNotification,
  futureStart,
  notificationsOf,
  rebasePendingOutbox,
  recordConsent,
  updateSettings,
  utcAt,
} from './notification-fixtures';

const START = futureStart(15, 14);
const TAKEN = utcAt(START, -5, 11);
const AFTER_TAKEN = new Date(TAKEN.getTime() + MINUTE_MS);

describe('dispatcher : envoi des notifications', () => {
  let app: INestApplication;
  let tenant: TenantFixture;
  let receptionist: UserFixture;
  let patientId: string;
  let dayOffset = 0;

  beforeAll(async () => {
    const { overrides } = createClockOverrides();
    app = await createTestApp({}, { providerOverrides: overrides });
    tenant = await createTenantFixture(app, { prefix: 'dispatch' });
    receptionist = await createUserWithRole(app, tenant, 'receptionist');
    patientId = await createPatientWithContacts(app, tenant, { firstName: 'Fatoumata', lastName: 'Secrete' });
    await recordConsent(app, tenant, patientId, 'sms');
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    sandboxOf(app).clear();
    (app.get(MAILER) as MemoryMailer).clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Rendez-vous à un jour distinct (aucun chevauchement entre tests), « pris » à `taken`. */
  async function book(options: { patient?: string; offsetDays?: number } = {}): Promise<{ id: string; start: Date; taken: Date }> {
    dayOffset += 1;
    const start = futureStart((options.offsetDays ?? 30) + dayOffset, 14);
    const taken = utcAt(start, -5, 11);
    const id = await bookAppointment(app, tenant, receptionist, { patientId: options.patient ?? patientId, startsAt: start, reason: SECRET_REASON });
    await rebasePendingOutbox(app, tenant, taken);
    return { id, start, taken };
  }

  it('envoie le SMS de confirmation : sent, segments, destinataire masqué et empreinte, sans texte rendu en base', async () => {
    const { id, taken } = await book();

    await runDispatcher(app, new Date(taken.getTime() + MINUTE_MS), tenant);

    const row = await findNotification(app, tenant, id, 'appointment.confirmed');
    expect(row).toMatchObject({ status: 'sent', channel: 'sms', provider: 'sandbox', attempts: 1, templateSource: 'default', templateVersion: 1, encoding: 'GSM7' });
    expect(row.segments).toBeGreaterThanOrEqual(1);
    expect(row.recipientMasked).toBe('+22177*****45');
    expect(row.recipientHash).toHaveLength(32);
    expect(row.providerMessageId).toMatch(/^sbx-/);
    expect(row.sentAt).toEqual(new Date(taken.getTime() + MINUTE_MS));
    const [sms] = sandboxOf(app).messages;
    expect(sms?.to).toBe(PATIENT_PHONE);
    expect(sms?.clientRef).toBe(`${tenant.tenantId}.${row.id}`);
    const attempts = await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.notificationAttempt.findMany({ where: { notificationId: row.id } }));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ outcome: 'sent', attempt: 1, provider: 'sandbox' });
  });

  it('le SMS ne contient ni motif, ni nom du patient, ni lien (aucune PHI)', async () => {
    const { taken } = await book();

    await runDispatcher(app, new Date(taken.getTime() + MINUTE_MS), tenant);

    const text = sandboxOf(app).messages.map((m) => m.text).join('\n');
    expect(text).toContain('rendez-vous confirmé');
    expect(text).not.toContain('VIH');
    expect(text).not.toContain('Secrete');
    expect(text).not.toMatch(/https?:\/\//);
  });

  it('aucune PHI dans les colonnes de notifications, de tentatives et d’outbox, ni dans les journaux applicatifs', async () => {
    const spies = (['log', 'error', 'warn', 'debug', 'verbose'] as const).map((level) => vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined));
    const { id, taken } = await book();
    sandboxOf(app).failNext(new SmsProviderError('transient', 'http_503'));

    await runDispatcher(app, new Date(taken.getTime() + MINUTE_MS), tenant);
    await runDispatcher(app, new Date(taken.getTime() + 5 * MINUTE_MS), tenant);

    const db = app.get(TenantDb);
    const dump = JSON.stringify(
      await db.runAs(tenant.tenantId, async (tx) => ({
        notifications: await tx.notification.findMany({ where: { subjectId: id } }),
        attempts: await tx.notificationAttempt.findMany({}),
        outbox: await tx.notificationOutboxEvent.findMany({ where: { aggregateId: id } }),
      })),
      (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
    );
    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    for (const haystack of [dump, logged]) {
      expect(haystack).not.toContain(PATIENT_PHONE.slice(1));
      expect(haystack).not.toContain('Fatoumata');
      expect(haystack).not.toContain('Secrete');
      expect(haystack).not.toContain('VIH');
      expect(haystack).not.toContain(PATIENT_EMAIL);
    }
    expect(logged).toContain('notificationId');
  });

  describe('fraîcheur à l’envoi', () => {
    async function dueReminder(): Promise<{ id: string; start: Date; h2At: Date }> {
      const { id, start, taken } = await book();
      await runDispatcher(app, new Date(taken.getTime() + MINUTE_MS), tenant);
      return { id, start, h2At: new Date(start.getTime() - 2 * HOUR_MS + MINUTE_MS) };
    }

    const patchAppointment = (id: string, data: Record<string, unknown>) =>
      app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.appointment.update({ where: { tenantId_id: { tenantId: tenant.tenantId, id } }, data }));

    it('envoie le rappel H-2 à l’heure prévue', async () => {
      const { id, h2At } = await dueReminder();

      await runDispatcher(app, h2At, tenant);

      expect(await findNotification(app, tenant, id, 'appointment.reminder_h2')).toMatchObject({ status: 'sent' });
      expect(sandboxOf(app).messages.at(-1)?.text).toContain('rappel');
    });

    it('supprime le rappel d’un rendez-vous déplacé hors outbox (stale)', async () => {
      const { id, start, h2At } = await dueReminder();
      await patchAppointment(id, { startsAt: new Date(start.getTime() + HOUR_MS), endsAt: new Date(start.getTime() + 2 * HOUR_MS) });

      await runDispatcher(app, h2At, tenant);

      expect(await findNotification(app, tenant, id, 'appointment.reminder_h2')).toMatchObject({ status: 'suppressed', suppressionReason: 'stale' });
    });

    it('supprime le rappel d’un rendez-vous annulé (appointment_cancelled)', async () => {
      const { id, h2At } = await dueReminder();
      await patchAppointment(id, { status: 'cancelled' });

      await runDispatcher(app, h2At, tenant);

      expect(await findNotification(app, tenant, id, 'appointment.reminder_h2')).toMatchObject({ status: 'suppressed', suppressionReason: 'appointment_cancelled' });
    });

    it('supprime le rappel d’un patient déjà arrivé (stale)', async () => {
      const { id, h2At } = await dueReminder();
      await patchAppointment(id, { status: 'checked_in' });

      await runDispatcher(app, h2At, tenant);

      expect(await findNotification(app, tenant, id, 'appointment.reminder_h2')).toMatchObject({ status: 'suppressed', suppressionReason: 'stale' });
    });

    it('supprime recipient_inactive pour un patient décédé depuis la planification', async () => {
      const { id, h2At } = await dueReminder();
      await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.patient.update({ where: { tenantId_id: { tenantId: tenant.tenantId, id: patientId } }, data: { deceasedAt: new Date() } }));

      try {
        await runDispatcher(app, h2At, tenant);

        expect(await findNotification(app, tenant, id, 'appointment.reminder_h2')).toMatchObject({ status: 'suppressed', suppressionReason: 'recipient_inactive' });
      } finally {
        await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.patient.update({ where: { tenantId_id: { tenantId: tenant.tenantId, id: patientId } }, data: { deceasedAt: null } }));
      }
    });

    it('échoue en deadline_exceeded quand le rappel H-2 est traité trop tard (RDV − 30 min)', async () => {
      const { id, start } = await dueReminder();
      sandboxOf(app).clear();

      await runDispatcher(app, new Date(start.getTime() - 20 * MINUTE_MS), tenant);

      expect(await findNotification(app, tenant, id, 'appointment.reminder_h2')).toMatchObject({ status: 'failed', errorCode: 'deadline_exceeded' });
      expect(sandboxOf(app).messages).toHaveLength(0);
    });
  });

  describe('consentement', () => {
    it('sans consentement, les rappels sont consignés no_consent et la confirmation part quand même', async () => {
      const patient = await createPatientWithContacts(app, tenant);
      const { id, taken } = await book({ patient });

      await runDispatcher(app, new Date(taken.getTime() + MINUTE_MS), tenant);

      expect(await findNotification(app, tenant, id, 'appointment.confirmed')).toMatchObject({ status: 'sent' });
      const reminders = await notificationsOf(app, tenant, { subjectId: id, category: 'clinical_reminder' });
      expect(reminders.map((r) => [r.status, r.suppressionReason])).toEqual([
        ['suppressed', 'no_consent'],
        ['suppressed', 'no_consent'],
      ]);
    });

    it('un consentement révoqué après la planification supprime le rappel à l’envoi (no_consent)', async () => {
      const patient = await createPatientWithContacts(app, tenant);
      await recordConsent(app, tenant, patient, 'sms', true);
      const { id, start, taken } = await book({ patient });
      await runDispatcher(app, new Date(taken.getTime() + MINUTE_MS), tenant);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await recordConsent(app, tenant, patient, 'sms', false);

      await runDispatcher(app, new Date(start.getTime() - 2 * HOUR_MS + MINUTE_MS), tenant);

      expect(await findNotification(app, tenant, id, 'appointment.reminder_h2')).toMatchObject({ status: 'suppressed', suppressionReason: 'no_consent' });
    });
  });

  describe('plage silencieuse (SMS seulement)', () => {
    it('reporte la confirmation de nuit à la fin de plage (07:00 + dispersion) puis l’envoie', async () => {
      const { id, start } = await book();
      const night = utcAt(start, -5, 22, 30);
      await rebasePendingOutbox(app, tenant, night);

      await runDispatcher(app, night, tenant);
      const deferred = await findNotification(app, tenant, id, 'appointment.confirmed');

      expect(deferred.status).toBe('queued');
      expect(deferred.attempts).toBe(0);
      const morning = utcAt(start, -4, 7);
      expect(deferred.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(morning.getTime());
      expect(deferred.nextAttemptAt.getTime()).toBeLessThanOrEqual(morning.getTime() + 10 * MINUTE_MS);
      expect(sandboxOf(app).messages).toHaveLength(0);

      await runDispatcher(app, new Date(morning.getTime() + 11 * MINUTE_MS), tenant);

      expect(await findNotification(app, tenant, id, 'appointment.confirmed')).toMatchObject({ status: 'sent' });
      expect(sandboxOf(app).messages).toHaveLength(1);
    });

    it('annule un rappel H-2 dont la fin de plage tombe à moins d’1 h du rendez-vous (too_late)', async () => {
      const early = utcAt(futureStart(60, 14), 0, 7, 30);
      const { id } = await bookWith(early);
      const h2Time = new Date(early.getTime() - 2 * HOUR_MS);

      await runDispatcher(app, new Date(h2Time.getTime() + MINUTE_MS), tenant);

      expect(await findNotification(app, tenant, id, 'appointment.reminder_h2')).toMatchObject({ status: 'suppressed', suppressionReason: 'too_late' });
    });

    async function bookWith(startsAt: Date): Promise<{ id: string }> {
      const taken = utcAt(startsAt, -5, 11);
      const id = await bookAppointment(app, tenant, receptionist, { patientId, startsAt });
      await rebasePendingOutbox(app, tenant, taken);
      await runDispatcher(app, new Date(taken.getTime() + MINUTE_MS), tenant);
      return { id };
    }

    it('ne retarde pas les e-mails : seul le SMS respecte la plage', async () => {
      const patient = await createPatientWithContacts(app, tenant, { phone: null });
      const { id, start } = await book({ patient });
      const night = utcAt(start, -5, 23, 0);
      await rebasePendingOutbox(app, tenant, night);

      await runDispatcher(app, night, tenant);

      expect(await findNotification(app, tenant, id, 'appointment.confirmed')).toMatchObject({ channel: 'email', status: 'sent' });
    });
  });

  describe('erreurs du fournisseur', () => {
    it('rejoue une erreur transitoire avec backoff puis échoue en max_attempts après 5 tentatives', async () => {
      const { id, taken } = await book();
      for (let i = 0; i < 5; i += 1) sandboxOf(app).failNext(new SmsProviderError('transient', 'http_503'));
      let now = new Date(taken.getTime() + MINUTE_MS);
      const waits: number[] = [];

      for (let attempt = 1; attempt <= 5; attempt += 1) {
        await runDispatcher(app, now, tenant);
        const row = await findNotification(app, tenant, id, 'appointment.confirmed');
        if (attempt < 5) {
          expect(row).toMatchObject({ status: 'queued', attempts: attempt, errorClass: 'transient', errorCode: 'http_503' });
          waits.push(row.nextAttemptAt.getTime() - now.getTime());
          now = row.nextAttemptAt;
        }
      }

      const final = await findNotification(app, tenant, id, 'appointment.confirmed');
      expect(final).toMatchObject({ status: 'failed', attempts: 5, errorCode: 'max_attempts', errorClass: 'transient' });
      expect(waits[1]).toBeGreaterThan(waits[0] as number);
      expect(waits[0]).toBeGreaterThanOrEqual(27_000);
      expect(waits[0]).toBeLessThanOrEqual(33_000);
      const attempts = await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.notificationAttempt.findMany({ where: { notificationId: final.id }, orderBy: { attempt: 'asc' } }));
      expect(attempts.map((a) => a.outcome)).toEqual(['retry_scheduled', 'retry_scheduled', 'retry_scheduled', 'retry_scheduled', 'failed']);
    });

    it('un échec définitif (permanent_recipient) est immédiat, sans nouvel essai', async () => {
      const { id, taken } = await book();
      sandboxOf(app).failNext(new SmsProviderError('permanent_recipient', 'http_400'));

      await runDispatcher(app, new Date(taken.getTime() + MINUTE_MS), tenant);

      expect(await findNotification(app, tenant, id, 'appointment.confirmed')).toMatchObject({ status: 'failed', attempts: 1, errorClass: 'permanent_recipient', errorCode: 'http_400' });
    });

    it('une erreur de configuration (permanent_config) est définitive', async () => {
      const { id, taken } = await book();
      sandboxOf(app).failNext(new SmsProviderError('permanent_config', 'http_401'));

      await runDispatcher(app, new Date(taken.getTime() + MINUTE_MS), tenant);

      expect(await findNotification(app, tenant, id, 'appointment.confirmed')).toMatchObject({ status: 'failed', errorClass: 'permanent_config' });
    });
  });

  it('deux dispatchers concurrents n’envoient qu’un seul SMS (réservation SKIP LOCKED)', async () => {
    const { id, taken } = await book();
    const now = new Date(taken.getTime() + MINUTE_MS);

    await Promise.all([runDispatcher(app, now, tenant), runDispatcher(app, now, tenant)]);

    expect(sandboxOf(app).messages).toHaveLength(1);
    expect(await notificationsOf(app, tenant, { subjectId: id, typeCode: 'appointment.confirmed' })).toHaveLength(1);
  });

  describe('canal e-mail', () => {
    it('envoie la confirmation par e-mail (adresse déchiffrée en mémoire, HTML échappé, empreinte et masque stockés)', async () => {
      const patient = await createPatientWithContacts(app, tenant, { phone: null, firstName: '<b>Awa</b>' });
      const { id, taken } = await book({ patient });

      await runDispatcher(app, new Date(taken.getTime() + MINUTE_MS), tenant);

      const row = await findNotification(app, tenant, id, 'appointment.confirmed');
      expect(row).toMatchObject({ channel: 'email', status: 'sent', provider: 'smtp', recipientMasked: 'a***@e***.sn' });
      expect(row.recipientHash).toHaveLength(32);
      const mail = (app.get(MAILER) as MemoryMailer).lastTo(PATIENT_EMAIL);
      expect(mail?.subject).toContain('Rendez-vous confirmé');
      expect(mail?.text).toContain('<b>Awa</b>');
      expect(mail?.html).toContain('&lt;b&gt;Awa&lt;/b&gt;');
      expect(mail?.html).not.toContain('<b>');
      expect(JSON.stringify(row)).not.toContain(PATIENT_EMAIL);
    });

    it('classe une panne SMTP inconnue en transitoire et reprogramme l’envoi', async () => {
      const patient = await createPatientWithContacts(app, tenant, { phone: null });
      const { id, taken } = await book({ patient });
      (app.get(MAILER) as MemoryMailer).failOnNextSend();
      const now = new Date(taken.getTime() + MINUTE_MS);

      await runDispatcher(app, now, tenant);

      const row = await findNotification(app, tenant, id, 'appointment.confirmed');
      expect(row).toMatchObject({ status: 'queued', attempts: 1, errorClass: 'transient', errorCode: 'smtp_unknown' });
      expect(row.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(now.getTime() + 54_000);

      await runDispatcher(app, row.nextAttemptAt, tenant);

      expect(await findNotification(app, tenant, id, 'appointment.confirmed')).toMatchObject({ status: 'sent', attempts: 2 });
    });
  });

  describe('réglages de l’établissement', () => {
    afterEach(async () => {
      await updateSettings(app, tenant, { appointmentSmsEnabled: true, reminderD1Enabled: true, reminderH2Enabled: true });
    });

    it('appointmentSmsEnabled=false : la confirmation passe par e-mail', async () => {
      await updateSettings(app, tenant, { appointmentSmsEnabled: false });
      const { id, taken } = await book();

      await runDispatcher(app, new Date(taken.getTime() + MINUTE_MS), tenant);

      expect(await findNotification(app, tenant, id, 'appointment.confirmed')).toMatchObject({ channel: 'email', status: 'sent' });
    });

    it('reminderD1Enabled=false : aucun rappel J-1 n’est planifié', async () => {
      await updateSettings(app, tenant, { reminderD1Enabled: false });
      const { id, taken } = await book();

      await runDispatcher(app, new Date(taken.getTime() + MINUTE_MS), tenant);

      expect((await notificationsOf(app, tenant, { subjectId: id })).map((r) => r.typeCode).sort()).toEqual(['appointment.confirmed', 'appointment.reminder_h2']);
    });

    it('sender_display_name remplace le nom de l’établissement dans le message', async () => {
      await updateSettings(app, tenant, { senderDisplayName: 'Clinique Awa' });
      const { taken } = await book();

      await runDispatcher(app, new Date(taken.getTime() + MINUTE_MS), tenant);

      expect(sandboxOf(app).messages[0]?.text.startsWith('Clinique Awa :')).toBe(true);
      await updateSettings(app, tenant, { senderDisplayName: null });
    });
  });

  it('la passe ne traite que les établissements demandés (tenantIds)', async () => {
    const other = await createTenantFixture(app, { prefix: 'dispatch-other' });

    const report = await runDispatcher(app, AFTER_TAKEN, other);

    expect(report).toMatchObject({ tenants: 1, relayed: 0, delivered: 0, errors: 0 });
  });
});
