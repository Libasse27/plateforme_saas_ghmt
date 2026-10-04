import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Clock } from '../../src/common/time/clock';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { createPatientRow, createPractitionerRow, createSite, grantScoped, slot } from '../appointments/appointment-fixtures';
import { createTenantFixture, createUserWithPermissions, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { createReceptionistWith } from './patient-fixtures';

/** Re-revue : audit et périmètre des doublons, projection par patient, détection élargie, date de naissance, suppression. */
describe('patients : re-revue (HTTP)', () => {
  let app: INestApplication;
  let tenantDb: TenantDb;
  let a: TenantFixture;
  let siteA: string;
  let siteB: string;
  let receptionist: UserFixture;
  let manager: UserFixture;
  let counter = 0;

  const http = () => request(app.getHttpServer());
  const auth = (user: UserFixture) => ({ Authorization: `Bearer ${user.token}` });

  function uniquePhone(): string {
    counter += 1;
    return `+22178${String(2000000 + counter * 7919).slice(-7)}`;
  }

  function newPatient(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    counter += 1;
    return { lastName: `Rerevue${counter}`, firstName: 'Test', birthDate: '1990-01-01', sex: 'female', phone: uniquePhone(), ...overrides };
  }

  async function createPatient(user: UserFixture, body: Record<string, unknown> = newPatient()) {
    const res = await http().post('/api/v1/patients').set(auth(user)).send(body).expect(201);
    return res.body.data as Record<string, any>;
  }

  const auditOf = (action: string) => tenantDb.runAs(a.tenantId, (tx) => tx.auditLog.findMany({ where: { action }, orderBy: { chainSeq: 'asc' } }));
  const patchPatient = (user: UserFixture, patient: Record<string, any>, body: Record<string, unknown>) =>
    http().patch(`/api/v1/patients/${patient['id']}`).set(auth(user)).set('If-Match', `"${patient['rowVersion']}"`).send(body);

  beforeAll(async () => {
    app = await createTestApp();
    tenantDb = app.get(TenantDb);
    a = await createTenantFixture(app, { prefix: 'pat-rr' });
    siteA = await createSite(app, a, `RA${Date.now() % 100000}`);
    siteB = await createSite(app, a, `RB${Date.now() % 100000}`);
    receptionist = await createUserWithRole(app, a, 'receptionist');
    manager = await createReceptionistWith(app, a, ['patients:patient:delete']);
  });

  afterAll(async () => {
    await app?.close();
  });

  afterEach(() => vi.restoreAllMocks());

  describe('audit du 409 patient_duplicate (point 1)', () => {
    it('audite patient.duplicate_detected (ids des candidats, types de critères, jamais les valeurs) malgré le 409', async () => {
      const phone = uniquePhone();
      const existing = await createPatient(receptionist, newPatient({ lastName: 'Auditee', firstName: 'Marie', phone }));

      const res = await http().post('/api/v1/patients').set(auth(receptionist)).send(newPatient({ lastName: 'Auditee', firstName: 'Marie', phone })).expect(409);

      const logs = await auditOf('patient.duplicate_detected');
      const log = logs.find((entry) => (entry.changes as { patientIds: string[] }).patientIds.includes(existing['id']));
      expect(res.body.code).toBe('patient_duplicate');
      expect(log).toBeDefined();
      expect(log?.outcome).toBe('success');
      expect(log?.changes).toMatchObject({ patientIds: [existing['id']], criteria: expect.arrayContaining(['name', 'birthDate', 'phone']) });
      const dump = JSON.stringify(log?.changes);
      for (const secret of [phone, 'Auditee', 'Marie', '1990-01-01']) expect(dump).not.toContain(secret);
    });
  });

  describe('doublon hors périmètre (point 2)', () => {
    let scoped: UserFixture;
    let hidden: Record<string, any>;
    let phone: string;

    beforeAll(async () => {
      scoped = await createUserWithRole(app, a, 'receptionist', { scopeType: 'site', scopeId: siteA });
      phone = uniquePhone();
      hidden = await createPatient(receptionist, newPatient({ phone, primarySiteId: siteB, lastName: 'CacheHorsPerimetre' }));
    });

    it('renvoie 409 patient_duplicate_out_of_scope sans aucun détail, et l’audite avec les ids', async () => {
      const res = await http().post('/api/v1/patients').set(auth(scoped)).send(newPatient({ phone })).expect(409);

      expect(res.body.code).toBe('patient_duplicate_out_of_scope');
      expect(res.body).not.toHaveProperty('details');
      expect(JSON.stringify(res.body)).not.toMatch(/candidates|CacheHorsPerimetre|P\d{2}-\d{7}/);
      const logs = await auditOf('patient.duplicate_out_of_scope');
      const log = logs.find((entry) => (entry.changes as { patientIds: string[] }).patientIds.includes(hidden['id']));
      expect(log?.outcome).toBe('success');
      expect(JSON.stringify(log?.changes)).not.toContain(phone);
    });

    it('se force avec ?force=true et forceReason comme un doublon classique, et exige le motif (422)', async () => {
      await http().post('/api/v1/patients?force=true').set(auth(scoped)).send(newPatient({ phone })).expect(422);

      await http()
        .post('/api/v1/patients?force=true')
        .set(auth(scoped))
        .send(newPatient({ phone, forceReason: 'Homonyme confirmé par le patient' }))
        .expect(201);
    });

    it('renvoie le doublon classique avec les seuls candidats visibles quand il en existe aussi hors périmètre', async () => {
      const sharedPhone = uniquePhone();
      const visible = await createPatient(receptionist, newPatient({ phone: sharedPhone, primarySiteId: siteA }));
      await createPatient(receptionist, { ...newPatient({ primarySiteId: siteB }), phone: undefined, lastName: 'Rerevue-voisin', firstName: 'Seul' });

      const res = await http().post('/api/v1/patients').set(auth(scoped)).send(newPatient({ phone: sharedPhone })).expect(409);

      expect(res.body.code).toBe('patient_duplicate');
      expect(res.body.details.candidates.map((c: { id: string }) => c.id)).toEqual([visible['id']]);
    });
  });

  describe('projection complète décidée par patient (point 3) et fiche (point 9)', () => {
    let siteWriter: UserFixture;
    let readerOnly: UserFixture;
    let inSite: Record<string, any>;
    let otherSite: Record<string, any>;
    let noSite: Record<string, any>;

    beforeAll(async () => {
      inSite = await createPatient(receptionist, newPatient({ primarySiteId: siteA, email: 'in@example.org' }));
      otherSite = await createPatient(receptionist, newPatient({ primarySiteId: siteB, email: 'out@example.org' }));
      noSite = await createPatient(receptionist, newPatient({ email: 'none@example.org' }));
      siteWriter = await createUserWithPermissions(app, a, ['patients:patient:read']);
      await grantScoped(app, a, siteWriter.userId, ['patients:patient:update'], { scopeType: 'site', scopeId: siteA });
      readerOnly = await createUserWithPermissions(app, a, ['patients:patient:read']);
    });

    it('déchiffre les coordonnées seulement des patients couverts par la portée de patients:patient:update', async () => {
      const get = (user: UserFixture, p: Record<string, any>) => http().get(`/api/v1/patients/${p['id']}`).set(auth(user)).expect(200);

      const mine = (await get(siteWriter, inSite)).body.data;
      const other = (await get(siteWriter, otherSite)).body.data;
      const none = (await get(siteWriter, noSite)).body.data;

      expect(mine).toMatchObject({ phone: inSite['phone'], email: 'in@example.org', contactRedacted: false });
      expect(other).toMatchObject({ phone: null, email: null, nationalId: null, address: null, contactRedacted: true });
      expect(none).toMatchObject({ email: 'none@example.org', contactRedacted: false });
    });

    it('marque contactRedacted pour un lecteur sans droit de modification, et pas pour un rédacteur de portée établissement', async () => {
      const reader = await http().get(`/api/v1/patients/${inSite['id']}`).set(auth(readerOnly)).expect(200);
      const writer = await http().get(`/api/v1/patients/${inSite['id']}`).set(auth(receptionist)).expect(200);

      expect(reader.body.data).toMatchObject({ phone: null, contactRedacted: true });
      expect(writer.body.data).toMatchObject({ phone: inSite['phone'], contactRedacted: false });
    });

    it('applique la même décision au résultat d’un PATCH', async () => {
      const res = await patchPatient(siteWriter, inSite, { city: 'Thiès' }).expect(200);

      expect(res.body.data).toMatchObject({ city: 'Thiès', contactRedacted: false, phone: inSite['phone'] });
    });

    it('expose deceasedAt dans la fiche', async () => {
      const created = await createPatient(receptionist);
      expect((await http().get(`/api/v1/patients/${created['id']}`).set(auth(receptionist)).expect(200)).body.data.deceasedAt).toBeNull();
      await tenantDb.runAs(a.tenantId, (tx) => tx.patient.update({ where: { tenantId_id: { tenantId: a.tenantId, id: created['id'] } }, data: { deceasedAt: new Date('2027-01-02T10:00:00Z') } }));

      const res = await http().get(`/api/v1/patients/${created['id']}`).set(auth(receptionist)).expect(200);

      expect(res.body.data.deceasedAt).toBe('2027-01-02T10:00:00.000Z');
    });

    it('nomme les candidats de doublon « Prénom NOM »', async () => {
      const phone = uniquePhone();
      await createPatient(receptionist, newPatient({ lastName: 'Diop-Ndiaye', firstName: 'Awa', phone }));

      const res = await http().post('/api/v1/patients').set(auth(receptionist)).send(newPatient({ phone })).expect(409);

      expect(res.body.details.candidates[0].fullName).toBe('Awa DIOP-NDIAYE');
    });
  });

  describe('détection élargie (point 7)', () => {
    it('signale un homonyme sans date de naissance quand le nouveau patient en a une', async () => {
      await createPatient(receptionist, { lastName: 'Nomseul', firstName: 'Fatou', sex: 'female' });

      const res = await http().post('/api/v1/patients').set(auth(receptionist)).send({ lastName: 'NOMSEUL', firstName: 'fatou', birthDate: '1980-02-03' }).expect(409);

      expect(res.body.code).toBe('patient_duplicate');
    });

    it('signale un homonyme daté quand le nouveau patient n’a pas de date de naissance', async () => {
      await createPatient(receptionist, { lastName: 'Nomseul2', firstName: 'Ibou', birthDate: '1975-05-05' });

      const res = await http().post('/api/v1/patients').set(auth(receptionist)).send({ lastName: 'Nomseul2', firstName: 'Ibou' }).expect(409);

      expect(res.body.code).toBe('patient_duplicate');
    });

    it('ne signale pas deux homonymes de dates connues différentes', async () => {
      await createPatient(receptionist, { lastName: 'Nomseul3', firstName: 'Ada', birthDate: '1975-05-05' });

      await http().post('/api/v1/patients').set(auth(receptionist)).send({ lastName: 'Nomseul3', firstName: 'Ada', birthDate: '1976-05-05' }).expect(201);
    });

    it('normalise le n° de pièce (espaces, tirets, casse) à la création, à la mise à jour et à la détection', async () => {
      await createPatient(receptionist, newPatient({ nationalId: 'ab 123-45' }));
      const dup = await http().post('/api/v1/patients').set(auth(receptionist)).send(newPatient({ nationalId: 'AB12345' })).expect(409);
      const other = await createPatient(receptionist, newPatient());
      await patchPatient(receptionist, other, { nationalId: 'zz-999 88' }).expect(200);

      const afterPatch = await http().post('/api/v1/patients').set(auth(receptionist)).send(newPatient({ nationalId: 'ZZ99988' })).expect(409);

      expect(dup.body.code).toBe('patient_duplicate');
      expect(afterPatch.body.code).toBe('patient_duplicate');
      const stored = await http().get(`/api/v1/patients/${other['id']}`).set(auth(receptionist)).expect(200);
      expect(stored.body.data.nationalId).toBe('zz-999 88');
    });
  });

  describe('date de naissance dans le fuseau du tenant (point 8)', () => {
    it('refuse en 422 une date qui est « demain » dans le fuseau du tenant, même si elle est ≤ aujourd’hui UTC', async () => {
      const realToday = new Date().toISOString().slice(0, 10);
      // Horloge reculée d’un jour : « aujourd’hui » dans le fuseau du tenant (UTC+0) est hier.
      vi.spyOn(app.get(Clock), 'now').mockReturnValue(new Date(Date.now() - 86_400_000));

      const created = await http().post('/api/v1/patients').set(auth(receptionist)).send(newPatient({ birthDate: realToday })).expect(422);
      const patient = await createPatient(receptionist);
      const updated = await patchPatient(receptionist, patient, { birthDate: realToday }).expect(422);

      for (const res of [created, updated]) expect(res.body.errors[0]).toMatchObject({ path: 'birthDate', code: 'birth_date_in_future' });
    });

    it('accepte aujourd’hui dans le fuseau du tenant', async () => {
      await http().post('/api/v1/patients').set(auth(receptionist)).send(newPatient({ birthDate: new Date().toISOString().slice(0, 10) })).expect(201);
    });
  });

  describe('suppression et rendez-vous futurs (point 10)', () => {
    it('annule dans la même transaction les rendez-vous futurs non terminés et audite leurs ids', async () => {
      const patient = await createPatient(receptionist, newPatient({ lastName: 'Annulable' }));
      const practitionerId = await createPractitionerRow(app, a);
      const base = { tenantId: a.tenantId, patientId: patient['id'], practitionerId, siteId: a.mainSiteId };
      const mk = (status: 'scheduled' | 'confirmed' | 'completed' | 'cancelled', dayOffset: number, startMinute = 0) =>
        tenantDb
          .runAs(a.tenantId, (tx) => tx.appointment.create({ data: { ...base, status, startsAt: new Date(slot(startMinute, 30, dayOffset).startsAt), endsAt: new Date(slot(startMinute, 30, dayOffset).endsAt) }, select: { id: true } }))
          .then((row) => row.id);
      const futureScheduled = await mk('scheduled', 60);
      const futureConfirmed = await mk('confirmed', 61);
      const futureCompleted = await mk('completed', 62);
      const futureCancelled = await mk('cancelled', 63);
      const pastScheduled = await tenantDb
        .runAs(a.tenantId, (tx) => tx.appointment.create({ data: { ...base, status: 'scheduled', startsAt: new Date('2020-01-01T08:00:00Z'), endsAt: new Date('2020-01-01T08:30:00Z') }, select: { id: true } }))
        .then((row) => row.id);

      await http()
        .delete(`/api/v1/patients/${patient['id']}`)
        .set(auth(manager))
        .set('If-Match', `"${patient['rowVersion']}"`)
        .send({ reason: 'Saisie par erreur' })
        .expect(204);

      const rows = await tenantDb.runAs(a.tenantId, (tx) => tx.appointment.findMany({ where: { patientId: patient['id'] } }));
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const id of [futureScheduled, futureConfirmed]) expect(byId.get(id)).toMatchObject({ status: 'cancelled', cancelReason: 'patient_record_deleted' });
      expect(byId.get(futureCompleted)?.status).toBe('completed');
      expect(byId.get(futureCancelled)?.cancelReason).toBeNull();
      expect(byId.get(pastScheduled)?.status).toBe('scheduled');
      const log = (await auditOf('patient.deleted')).find((entry) => entry.resourceId === patient['id']);
      expect(log?.changes).toMatchObject({ reason: 'Saisie par erreur' });
      expect([...(log?.changes as { cancelledAppointmentIds: string[] }).cancelledAppointmentIds].sort()).toEqual([futureScheduled, futureConfirmed].sort());
    });
  });
});
