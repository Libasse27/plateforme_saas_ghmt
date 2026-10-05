import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlatformDb } from '../../src/infrastructure/prisma/platform-db.service';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { createSite } from '../appointments/appointment-fixtures';
import { createTenantFixture, createUserWithPermissions, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { runDispatcher } from './dispatch-fixtures';
import {
  API,
  MINUTE_MS,
  bearer,
  bookAppointment,
  createClockOverrides,
  createPatientWithContacts,
  futureStart,
  http,
  notificationsOf,
  rebasePendingOutbox,
  utcAt,
} from './notification-fixtures';

const UNKNOWN = '0197a3c0-0000-7000-8000-0000000000ff';
const GRANT_SMS = { channel: 'sms', purpose: 'appointment_reminder', granted: true, source: 'front_desk' };

describe('consentement du patient aux rappels', () => {
  let app: INestApplication;
  let a: TenantFixture;
  let b: TenantFixture;
  let receptionist: UserFixture;
  let accountant: UserFixture;
  let patientId: string;

  beforeAll(async () => {
    app = await createTestApp({}, { providerOverrides: createClockOverrides().overrides });
    [a, b] = await Promise.all([createTenantFixture(app, { prefix: 'consent-a' }), createTenantFixture(app, { prefix: 'consent-b' })]);
    receptionist = await createUserWithRole(app, a, 'receptionist');
    accountant = await createUserWithRole(app, a, 'accountant');
    patientId = await createPatientWithContacts(app, a);
  });

  afterAll(async () => {
    await app?.close();
  });

  const url = (id: string) => `${API}/patients/${id}/contact-consents`;
  const get = (token: string, id = patientId) => http(app).get(url(id)).set(bearer(token));
  const post = (token: string, body: unknown, id = patientId) => http(app).post(url(id)).set(bearer(token)).send(body as object);

  describe('GET', () => {
    it('retourne granted:false pour un canal jamais recueilli, avec un historique vide', async () => {
      const fresh = await createPatientWithContacts(app, a);

      const res = await get(receptionist.token, fresh).expect(200);

      expect(res.body.data).toEqual({
        patientId: fresh,
        current: [
          { channel: 'sms', purpose: 'appointment_reminder', granted: false, source: null, recordedAt: null },
          { channel: 'email', purpose: 'appointment_reminder', granted: false, source: null, recordedAt: null },
        ],
        history: [],
      });
    });

    it('audite la lecture (patient.consents_read) avec l’identifiant du patient', async () => {
      await get(receptionist.token).expect(200);

      const audit = await app.get(TenantDb).runAs(a.tenantId, (tx) => tx.auditLog.findFirstOrThrow({ where: { action: 'patient.consents_read', patientId }, orderBy: { chainSeq: 'desc' } }));

      expect(audit).toMatchObject({ resourceType: 'patient', resourceId: patientId, actorUserId: receptionist.userId });
    });

    it('refuse sans permission (403) et sans jeton (401)', async () => {
      await get(accountant.token).expect(403);
      await http(app).get(url(patientId)).expect(401);
    });
  });

  describe('POST', () => {
    it('enregistre un consentement (201), met à jour l’état courant et l’historique, audite le changement', async () => {
      const patient = await createPatientWithContacts(app, a);

      const res = await post(receptionist.token, GRANT_SMS, patient).expect(201);

      expect(res.body.data.current[0]).toMatchObject({ channel: 'sms', granted: true, source: 'front_desk', recordedAt: expect.any(String) });
      expect(res.body.data.current[1]).toMatchObject({ channel: 'email', granted: false });
      expect(res.body.data.history).toEqual([expect.objectContaining({ channel: 'sms', granted: true, source: 'front_desk', purpose: 'appointment_reminder', id: expect.any(String), recordedAt: expect.any(String) })]);
      const audit = await app.get(TenantDb).runAs(a.tenantId, (tx) => tx.auditLog.findFirstOrThrow({ where: { action: 'patient.consent_changed', patientId: patient } }));
      expect(audit.changes).toEqual({ channel: 'sms', purpose: 'appointment_reminder', granted: true, source: 'front_desk' });
      const stored = await app.get(TenantDb).runAs(a.tenantId, (tx) => tx.patientContactConsent.findFirstOrThrow({ where: { patientId: patient } }));
      expect(stored.recordedBy).toBe(receptionist.userId);
    });

    it('le dernier enregistrement fait foi et l’historique garde tout (50 au plus, du plus récent au plus ancien)', async () => {
      const patient = await createPatientWithContacts(app, a);
      await post(receptionist.token, GRANT_SMS, patient).expect(201);
      await post(receptionist.token, { ...GRANT_SMS, granted: false, source: 'patient_request' }, patient).expect(201);

      const res = await get(receptionist.token, patient).expect(200);

      expect(res.body.data.current[0]).toMatchObject({ granted: false, source: 'patient_request' });
      expect(res.body.data.history.map((h: { granted: boolean }) => h.granted)).toEqual([false, true]);
    });

    it('une révocation supprime immédiatement les rappels en attente du canal (no_consent), pas la confirmation', async () => {
      const patient = await createPatientWithContacts(app, a);
      await post(receptionist.token, GRANT_SMS, patient).expect(201);
      const start = futureStart(80, 14);
      const taken = utcAt(start, -5, 11);
      const id = await bookAppointment(app, a, receptionist, { patientId: patient, startsAt: start });
      await rebasePendingOutbox(app, a, taken);
      await runDispatcher(app, new Date(taken.getTime() + MINUTE_MS), a);
      expect((await notificationsOf(app, a, { subjectId: id, category: 'clinical_reminder' })).every((r) => r.status === 'queued')).toBe(true);

      await post(receptionist.token, { ...GRANT_SMS, granted: false, source: 'patient_request' }, patient).expect(201);

      const reminders = await notificationsOf(app, a, { subjectId: id, category: 'clinical_reminder' });
      expect(reminders.map((r) => [r.status, r.suppressionReason])).toEqual([['suppressed', 'no_consent'], ['suppressed', 'no_consent']]);
      expect(await notificationsOf(app, a, { subjectId: id, typeCode: 'appointment.confirmed' })).toEqual([expect.objectContaining({ status: 'sent' })]);
    });

    it('un nouveau consentement ré-arme les rappels futurs supprimés faute de consentement', async () => {
      const patient = await createPatientWithContacts(app, a);
      const start = futureStart(81, 14);
      const taken = utcAt(start, -5, 11);
      const id = await bookAppointment(app, a, receptionist, { patientId: patient, startsAt: start });
      await rebasePendingOutbox(app, a, taken);
      await runDispatcher(app, new Date(taken.getTime() + MINUTE_MS), a);
      expect((await notificationsOf(app, a, { subjectId: id, category: 'clinical_reminder' })).every((r) => r.suppressionReason === 'no_consent')).toBe(true);

      await post(receptionist.token, GRANT_SMS, patient).expect(201);

      const reminders = await notificationsOf(app, a, { subjectId: id, category: 'clinical_reminder' });
      expect(reminders.every((r) => r.status === 'queued' && r.suppressionReason === null)).toBe(true);
    });

    it('refuse sms_stop, une finalité ou un canal inconnu, un corps incomplet (422)', async () => {
      for (const body of [{ ...GRANT_SMS, source: 'sms_stop' }, { ...GRANT_SMS, purpose: 'marketing' }, { ...GRANT_SMS, channel: 'inapp' }, { channel: 'sms' }, {}]) {
        await post(receptionist.token, body).expect(422);
      }
    });

    it('refuse sans permission (403) et sans jeton (401)', async () => {
      await post(accountant.token, GRANT_SMS).expect(403);
      await http(app).post(url(patientId)).send(GRANT_SMS).expect(401);
    });
  });

  describe('404 : patient inconnu, mal formé, d’un autre établissement ou hors périmètre', () => {
    it('ne révèle pas l’existence du patient', async () => {
      const foreign = await createPatientWithContacts(app, b);

      for (const id of [UNKNOWN, foreign, 'pas-un-uuid']) {
        await get(receptionist.token, id).expect(404);
        await post(receptionist.token, GRANT_SMS, id).expect(404);
      }
    });

    it('respecte le périmètre de patients:patient:read (patient d’un autre site)', async () => {
      const otherSite = await createSite(app, a, 'SITE-CONSENT');
      const scoped = await createUserWithPermissions(app, a, ['patients:consent:read', 'patients:consent:create', 'patients:patient:read'], { scopeType: 'site', scopeId: a.mainSiteId });
      const inScope = await createPatientWithContacts(app, a, { primarySiteId: a.mainSiteId });
      const outOfScope = await createPatientWithContacts(app, a, { primarySiteId: otherSite });

      await get(scoped.token, inScope).expect(200);
      await get(scoped.token, outOfScope).expect(404);
      await post(scoped.token, GRANT_SMS, outOfScope).expect(404);
      await post(scoped.token, GRANT_SMS, inScope).expect(201);
    });

    it('sans patients:patient:read, aucun patient n’est visible (404)', async () => {
      const blind = await createUserWithPermissions(app, a, ['patients:consent:read', 'patients:consent:create'], { scopeType: 'tenant' });

      await get(blind.token).expect(404);
    });
  });

  it('reste autorisé quand l’établissement est suspendu (@AllowWhenSuspended)', async () => {
    const tenant = await createTenantFixture(app, { prefix: 'consent-susp' });
    const user = await createUserWithRole(app, tenant, 'receptionist');
    const patient = await createPatientWithContacts(app, tenant);
    await app.get(PlatformDb).run((tx) => tx.tenant.update({ where: { id: tenant.tenantId }, data: { status: 'suspended' } }));

    await post(user.token, GRANT_SMS, patient).expect(201);
  });
});
