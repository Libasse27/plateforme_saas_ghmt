import { createHmac } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Clock } from '../../src/common/time/clock';
import { ENV, loadEnv } from '../../src/infrastructure/config/env';
import { PlatformDb } from '../../src/infrastructure/prisma/platform-db.service';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { createTenantFixture, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { runDispatcher, sandboxOf } from './dispatch-fixtures';
import {
  API,
  MINUTE_MS,
  PATIENT_PHONE,
  bookAppointment,
  createClockOverrides,
  createPatientWithContacts,
  findNotification,
  futureStart,
  http,
  notificationsOf,
  rebasePendingOutbox,
  recordConsent,
  utcAt,
} from './notification-fixtures';

const SECRET = 's'.repeat(32);
const HTTP_ENV = { SMS_PROVIDER: 'http', SMS_HTTP_URL: 'https://sms.example.com/send', SMS_HTTP_TOKEN: 't'.repeat(16), SMS_HTTP_WEBHOOK_SECRET: SECRET } as const;

const clientIp = (() => {
  let counter = 0;
  return (): string => `10.77.${(counter >> 8) & 255}.${(counter += 1) & 255}`;
})();

async function appWith(env: Record<string, unknown>): Promise<INestApplication> {
  const overrides = [...createClockOverrides().overrides, { token: ENV, useValue: Object.freeze({ ...loadEnv(), ...env }) }];
  return createTestApp({}, { providerOverrides: overrides });
}

function sign(raw: string, timestamp = Math.floor(Date.now() / 1000), secret = SECRET): Record<string, string> {
  const signature = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
  return { 'x-ghmt-timestamp': String(timestamp), 'x-ghmt-signature': signature };
}

describe('webhooks SMS : sandbox', () => {
  let app: INestApplication;
  let a: TenantFixture;
  let b: TenantFixture;
  let c: TenantFixture;
  let receptionistA: UserFixture;
  let receptionistB: UserFixture;
  let dayOffset = 0;

  beforeAll(async () => {
    app = await createTestApp({}, { providerOverrides: createClockOverrides().overrides });
    [a, b, c] = await Promise.all([
      createTenantFixture(app, { prefix: 'wh-a' }),
      createTenantFixture(app, { prefix: 'wh-b' }),
      createTenantFixture(app, { prefix: 'wh-c' }),
    ]);
    receptionistA = await createUserWithRole(app, a, 'receptionist');
    receptionistB = await createUserWithRole(app, b, 'receptionist');
  });

  afterAll(async () => {
    await app?.close();
  });

  const sandbox = (path: string, body: unknown) => http(app).post(`${API}/webhooks/sms/sandbox/${path}`).set('X-Forwarded-For', clientIp()).send(body as object);

  async function sendConfirmation(tenant: TenantFixture, user: UserFixture, patientId: string): Promise<{ id: string; start: Date; taken: Date }> {
    dayOffset += 1;
    const start = futureStart(100 + dayOffset, 14);
    const taken = utcAt(start, -5, 11);
    const id = await bookAppointment(app, tenant, user, { patientId, startsAt: start });
    await rebasePendingOutbox(app, tenant, taken);
    await runDispatcher(app, new Date(taken.getTime() + MINUTE_MS), tenant);
    return { id, start, taken };
  }

  describe('accusés de réception', () => {
    it('delivered : la notification envoyée devient delivered, de façon idempotente', async () => {
      const patient = await createPatientWithContacts(app, a);
      const { id } = await sendConfirmation(a, receptionistA, patient);
      const row = await findNotification(app, a, id, 'appointment.confirmed');
      const clientRef = `${a.tenantId}.${row.id}`;

      await sandbox('delivery', { clientRef, status: 'delivered' }).expect(204);
      await sandbox('delivery', { clientRef, status: 'delivered' }).expect(204);

      expect(await findNotification(app, a, id, 'appointment.confirmed')).toMatchObject({ status: 'delivered', deliveredAt: expect.any(Date) });
      const attempts = await app.get(TenantDb).runAs(a.tenantId, (tx) => tx.notificationAttempt.findMany({ where: { notificationId: row.id }, orderBy: { id: 'asc' } }));
      expect(attempts.map((x) => x.outcome)).toEqual(['sent', 'delivered']);
    });

    it.each(['undeliverable', 'failed'] as const)('%s : la notification passe en failed (permanent_recipient) avec le code fourni', async (status) => {
      const patient = await createPatientWithContacts(app, a);
      const { id } = await sendConfirmation(a, receptionistA, patient);
      const row = await findNotification(app, a, id, 'appointment.confirmed');

      await sandbox('delivery', { clientRef: `${a.tenantId}.${row.id}`, status, errorCode: 'UNKNOWN_SUBSCRIBER' }).expect(204);

      expect(await findNotification(app, a, id, 'appointment.confirmed')).toMatchObject({ status: 'failed', errorClass: 'permanent_recipient', errorCode: 'UNKNOWN_SUBSCRIBER' });
    });

    it('un accusé tardif ne modifie pas une notification déjà delivered', async () => {
      const patient = await createPatientWithContacts(app, a);
      const { id } = await sendConfirmation(a, receptionistA, patient);
      const row = await findNotification(app, a, id, 'appointment.confirmed');
      const clientRef = `${a.tenantId}.${row.id}`;
      await sandbox('delivery', { clientRef, status: 'delivered' }).expect(204);

      await sandbox('delivery', { clientRef, status: 'failed' }).expect(204);

      expect((await findNotification(app, a, id, 'appointment.confirmed')).status).toBe('delivered');
    });

    it('répond 204 pour un clientRef inconnu (aucun oracle), y compris celui d’un autre établissement', async () => {
      const patient = await createPatientWithContacts(app, a);
      const { id } = await sendConfirmation(a, receptionistA, patient);
      const row = await findNotification(app, a, id, 'appointment.confirmed');
      const unknown = '0197a3c0-0000-7000-8000-0000000000ee';

      await sandbox('delivery', { clientRef: `${a.tenantId}.${unknown}`, status: 'delivered' }).expect(204);
      await sandbox('delivery', { clientRef: `${unknown}.${row.id}`, status: 'delivered' }).expect(204);
      await sandbox('delivery', { clientRef: `${b.tenantId}.${row.id}`, status: 'delivered' }).expect(204);

      expect((await findNotification(app, a, id, 'appointment.confirmed')).status).toBe('sent');
    });

    it('valide le corps (422) : clientRef mal formé, statut inconnu, code trop long', async () => {
      for (const body of [{ clientRef: 'abc', status: 'delivered' }, { clientRef: `${a.tenantId}.${a.tenantId}`, status: 'pending' }, { clientRef: `${a.tenantId}.${a.tenantId}`, status: 'failed', errorCode: 'x'.repeat(51) }]) {
        await sandbox('delivery', body).expect(422);
      }
    });
  });

  describe('STOP entrant', () => {
    it('révoque le consentement SMS et supprime les rappels dans CHAQUE établissement ayant écrit à ce numéro, pas ailleurs', async () => {
      const phone = '+221770000111';
      const patientA = await createPatientWithContacts(app, a, { phone });
      const patientB = await createPatientWithContacts(app, b, { phone });
      const patientC = await createPatientWithContacts(app, c, { phone });
      const otherPhonePatient = await createPatientWithContacts(app, a, { phone: '+221770000222' });
      for (const [tenant, patient] of [[a, patientA], [b, patientB], [c, patientC], [a, otherPhonePatient]] as const) await recordConsent(app, tenant, patient, 'sms');
      const apptA = await sendConfirmation(a, receptionistA, patientA);
      const apptB = await sendConfirmation(b, receptionistB, patientB);
      const apptOther = await sendConfirmation(a, receptionistA, otherPhonePatient);

      await sandbox('inbound', { from: phone, text: 'STOP' }).expect(204);

      for (const [tenant, patient, appt] of [[a, patientA, apptA], [b, patientB, apptB]] as const) {
        const latest = await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.patientContactConsent.findFirstOrThrow({ where: { patientId: patient }, orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }] }));
        expect(latest).toMatchObject({ channel: 'sms', granted: false, source: 'sms_stop', recordedBy: null });
        const reminders = await notificationsOf(app, tenant, { subjectId: appt.id, category: 'clinical_reminder' });
        expect(reminders.map((r) => [r.status, r.suppressionReason])).toEqual([['suppressed', 'no_consent'], ['suppressed', 'no_consent']]);
        const audit = await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.auditLog.findFirstOrThrow({ where: { action: 'patient.consent_changed', patientId: patient }, orderBy: { chainSeq: 'desc' } }));
        expect(audit).toMatchObject({ actorType: 'system', actorUserId: null });
        expect(audit.changes).toEqual({ channel: 'sms', purpose: 'appointment_reminder', granted: false, source: 'sms_stop' });
      }
      const cConsents = await app.get(TenantDb).runAs(c.tenantId, (tx) => tx.patientContactConsent.findMany({ where: { patientId: patientC } }));
      expect(cConsents.map((x) => x.source)).toEqual(['front_desk']);
      const untouched = await notificationsOf(app, a, { subjectId: apptOther.id, category: 'clinical_reminder' });
      expect(untouched.every((r) => r.status === 'queued')).toBe(true);
    });

    it.each(['stop', 'Arrêt.', 'STOP svp'])('reconnaît « %s » comme un STOP', async (text) => {
      const phone = `+2217700${Math.floor(1000 + Math.random() * 8999)}`;
      const patient = await createPatientWithContacts(app, a, { phone });
      await recordConsent(app, a, patient, 'sms');
      await sendConfirmation(a, receptionistA, patient);

      await sandbox('inbound', { from: phone, text }).expect(204);

      const latest = await app.get(TenantDb).runAs(a.tenantId, (tx) => tx.patientContactConsent.findFirstOrThrow({ where: { patientId: patient }, orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }] }));
      expect(latest.granted).toBe(false);
    });

    it('ignore un message qui n’est pas un STOP et un numéro jamais contacté', async () => {
      const phone = '+221770000333';
      const patient = await createPatientWithContacts(app, a, { phone });
      await recordConsent(app, a, patient, 'sms');
      await sendConfirmation(a, receptionistA, patient);

      await sandbox('inbound', { from: phone, text: 'OUI merci' }).expect(204);
      await sandbox('inbound', { from: '+221779999999', text: 'STOP' }).expect(204);

      const consents = await app.get(TenantDb).runAs(a.tenantId, (tx) => tx.patientContactConsent.findMany({ where: { patientId: patient } }));
      expect(consents).toHaveLength(1);
    });

    it('ne route pas un STOP vers un établissement dont le dernier SMS date de plus de 180 jours', async () => {
      const phone = '+221770000444';
      const patient = await createPatientWithContacts(app, a, { phone });
      await recordConsent(app, a, patient, 'sms');
      await sendConfirmation(a, receptionistA, patient);
      await app.get(PlatformDb).run((tx) => tx.smsRecipientTenant.updateMany({ where: { tenantId: a.tenantId }, data: { lastSentAt: new Date(Date.now() - 200 * 86_400_000) } }));

      await sandbox('inbound', { from: phone, text: 'STOP' }).expect(204);

      const consents = await app.get(TenantDb).runAs(a.tenantId, (tx) => tx.patientContactConsent.findMany({ where: { patientId: patient } }));
      expect(consents).toHaveLength(1);
    });

    it('le registre de routage ne contient que des empreintes (aucun numéro en clair)', async () => {
      const rows = await app.get(PlatformDb).run((tx) => tx.smsRecipientTenant.findMany({ where: { tenantId: a.tenantId } }));

      expect(rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(rows, (_k, v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : v))).not.toContain(PATIENT_PHONE.slice(1));
      expect(Buffer.from(rows[0]?.phoneHmac ?? []).length).toBe(32);
    });

    it('valide le corps (422) : numéro non E.164, texte de plus de 1600 caractères', async () => {
      await sandbox('inbound', { from: '0770000111', text: 'STOP' }).expect(422);
      await sandbox('inbound', { from: '+221770000111', text: 'x'.repeat(1601) }).expect(422);
    });
  });

  it('les routes http répondent 404 quand l’adaptateur http n’est pas configuré', async () => {
    const raw = JSON.stringify({ from: '+221770000111', text: 'STOP' });

    await http(app).post(`${API}/webhooks/sms/http/inbound`).set('content-type', 'application/json').set(sign(raw)).send(raw).expect(404);
    await http(app).post(`${API}/webhooks/sms/http/delivery`).set('content-type', 'application/json').send('{}').expect(404);
  });

  it('refuse un corps de plus de 64 Ko (413)', async () => {
    const big = JSON.stringify({ from: '+221770000111', text: 'x'.repeat(70_000) });

    await http(app).post(`${API}/webhooks/sms/sandbox/inbound`).set('X-Forwarded-For', clientIp()).set('content-type', 'application/json').send(big).expect(413);
  });

  it('limite le débit à 60 requêtes par minute et par adresse (429)', async () => {
    const ip = clientIp();
    const statuses: number[] = [];

    for (let i = 0; i < 62; i += 1) {
      const res = await http(app).post(`${API}/webhooks/sms/sandbox/inbound`).set('X-Forwarded-For', ip).send({ from: '+221770000555', text: 'bonjour' });
      statuses.push(res.status);
    }

    expect(statuses.filter((s) => s === 204)).toHaveLength(60);
    expect(statuses.slice(60)).toEqual([429, 429]);
  });
});

describe('webhooks SMS : adaptateur http (signature HMAC)', () => {
  let app: INestApplication;
  let tenant: TenantFixture;
  let user: UserFixture;
  let phone: string;
  let patientId: string;

  beforeAll(async () => {
    app = await appWith(HTTP_ENV);
    tenant = await createTenantFixture(app, { prefix: 'wh-http' });
    user = await createUserWithRole(app, tenant, 'receptionist');
    phone = '+221770000666';
    patientId = await createPatientWithContacts(app, tenant, { phone });
    await recordConsent(app, tenant, patientId, 'sms');
  });

  afterAll(async () => {
    await app?.close();
  });

  const call = (path: string, raw: string, headers: Record<string, string>) =>
    http(app).post(`${API}/webhooks/sms/http/${path}`).set('X-Forwarded-For', clientIp()).set('content-type', 'application/json').set(headers).send(raw);

  /** Insère une notification SMS « envoyée » (le fournisseur http n’est pas appelable en test). */
  async function sentRow(): Promise<{ id: string }> {
    return app.get(TenantDb).runAs(tenant.tenantId, (tx) =>
      tx.notification.create({
        data: {
          tenantId: tenant.tenantId,
          typeCode: 'appointment.confirmed',
          category: 'transactional',
          channel: 'sms',
          recipientType: 'patient',
          recipientId: patientId,
          dedupKey: createHmac('sha256', 'k').update(String(Math.random())).digest('hex'),
          locale: 'fr',
          status: 'sent',
          attempts: 1,
          scheduledAt: new Date(),
          nextAttemptAt: new Date(),
          sentAt: new Date(),
          provider: 'http',
        },
        select: { id: true },
      }),
    );
  }

  it('accepte une signature valide (204) et applique l’accusé', async () => {
    const row = await sentRow();
    const raw = JSON.stringify({ clientRef: `${tenant.tenantId}.${row.id}`, status: 'delivered' });

    await call('delivery', raw, sign(raw)).expect(204);

    const stored = await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.notification.findFirstOrThrow({ where: { id: row.id } }));
    expect(stored.status).toBe('delivered');
  });

  it('traite un STOP entrant signé', async () => {
    const hasher = (await import('../../src/modules/notifications/services/recipient-hasher')).RecipientHasher;
    const hmac = app.get(hasher).hash(phone);
    await app.get(PlatformDb).run((tx) =>
      tx.smsRecipientTenant.upsert({
        where: { phoneHmac_tenantId: { phoneHmac: new Uint8Array(hmac), tenantId: tenant.tenantId } },
        create: { phoneHmac: new Uint8Array(hmac), tenantId: tenant.tenantId, lastSentAt: new Date() },
        update: { lastSentAt: new Date() },
      }),
    );
    const raw = JSON.stringify({ from: phone, text: 'STOP' });

    await call('inbound', raw, sign(raw)).expect(204);

    const latest = await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.patientContactConsent.findFirstOrThrow({ where: { patientId }, orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }] }));
    expect(latest).toMatchObject({ granted: false, source: 'sms_stop' });
  });

  it('refuse (401 invalid_signature) une signature absente, invalide, ou calculée avec un autre secret', async () => {
    const raw = JSON.stringify({ from: '+221770000777', text: 'STOP' });
    const good = sign(raw);

    const missing = await call('inbound', raw, {}).expect(401);
    await call('inbound', raw, { ...good, 'x-ghmt-signature': 'f'.repeat(64) }).expect(401);
    await call('inbound', raw, { ...good, 'x-ghmt-signature': 'pas-hexa' }).expect(401);
    await call('inbound', raw, sign(raw, undefined, 'x'.repeat(32))).expect(401);
    await call('inbound', raw, { 'x-ghmt-timestamp': good['x-ghmt-timestamp'] as string }).expect(401);

    expect(missing.body.code).toBe('invalid_signature');
  });

  it('refuse un corps modifié après signature et un horodatage hors tolérance (± 300 s)', async () => {
    const raw = JSON.stringify({ from: '+221770000777', text: 'STOP' });
    // L'horloge de l'application est figée (MutableClock) : les bornes se calculent sur elle, pas sur l'heure réelle.
    const now = Math.floor(app.get(Clock).now().getTime() / 1000);

    await call('inbound', JSON.stringify({ from: '+221770000778', text: 'STOP' }), sign(raw)).expect(401);
    await call('inbound', raw, sign(raw, now - 301)).expect(401);
    await call('inbound', raw, sign(raw, now + 301)).expect(401);
    await call('inbound', raw, sign(raw, now - 299)).expect(204);
    await call('inbound', raw, { ...sign(raw), 'x-ghmt-timestamp': 'abc' }).expect(401);
    await call('inbound', raw, sign(raw, now)).expect(204);
  });

  it('les routes sandbox répondent 404 quand le fournisseur n’est pas sandbox', async () => {
    await http(app).post(`${API}/webhooks/sms/sandbox/inbound`).send({ from: '+221770000777', text: 'STOP' }).expect(404);
    await http(app).post(`${API}/webhooks/sms/sandbox/delivery`).send({ clientRef: `${tenant.tenantId}.${tenant.tenantId}`, status: 'delivered' }).expect(404);
  });

  it('valide le corps signé (422)', async () => {
    const raw = JSON.stringify({ from: 'pas-un-numero', text: 'STOP' });

    await call('inbound', raw, sign(raw)).expect(422);
  });
});

describe('webhooks SMS : adaptateur http sans secret', () => {
  it('répond 404 aux routes http', async () => {
    const app = await appWith({ SMS_PROVIDER: 'http', SMS_HTTP_URL: HTTP_ENV.SMS_HTTP_URL, SMS_HTTP_TOKEN: HTTP_ENV.SMS_HTTP_TOKEN, SMS_HTTP_WEBHOOK_SECRET: undefined });
    try {
      const raw = JSON.stringify({ from: '+221770000777', text: 'STOP' });
      await http(app).post(`${API}/webhooks/sms/http/inbound`).set('content-type', 'application/json').set(sign(raw)).send(raw).expect(404);
    } finally {
      await app.close();
    }
  });
});
