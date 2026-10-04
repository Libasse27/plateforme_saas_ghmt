import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Clock } from '../../src/common/time/clock';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { createTenantFixture, createUserWithPermissions, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { createPatientRow, createPractitionerRow, createSite, grantScoped, slot } from './appointment-fixtures';

const UNKNOWN_ID = '018f0000-0000-7000-8000-000000000000';
const BOOKING_PERMISSIONS = ['appointments:appointment:create', 'appointments:appointment:read', 'appointments:appointment:update'];

/** Re-revue : périmètre de la prise de RDV, motif clinique par ligne, décès en cours de consultation, forme de l'AppointmentView. */
describe('rendez-vous : re-revue (HTTP)', () => {
  let app: INestApplication;
  let tenantDb: TenantDb;
  let a: TenantFixture;
  let siteB: string;
  let receptionist: UserFixture;
  const http = () => request(app.getHttpServer());
  const auth = (user: UserFixture) => ({ Authorization: `Bearer ${user.token}` });

  async function payload(patientId: string, overrides: Record<string, unknown> = {}, range = slot(0)) {
    return { patientId, practitionerId: await createPractitionerRow(app, a), siteId: a.mainSiteId, ...range, ...overrides };
  }

  async function book(user: UserFixture, body: Record<string, unknown>) {
    const res = await http().post('/api/v1/appointments').set(auth(user)).send(body).expect(201);
    return res.body.data as Record<string, any>;
  }

  beforeAll(async () => {
    app = await createTestApp();
    tenantDb = app.get(TenantDb);
    a = await createTenantFixture(app, { prefix: 'rdv-rr' });
    siteB = await createSite(app, a, 'SITE-RR');
    receptionist = await createUserWithRole(app, a, 'receptionist');
  });

  afterAll(async () => {
    await app?.close();
  });

  afterEach(() => vi.restoreAllMocks());

  describe('motif de RDV selon la portée de consultations:consultation:read (point 4)', () => {
    it('ne renvoie reason et cancelReason que pour les rendez-vous situés dans la portée de la permission clinique', async () => {
      const patientId = await createPatientRow(app, a);
      const inScope = await book(receptionist, await payload(patientId, { reason: 'Motif site principal' }, slot(0, 30, 40)));
      const outOfScope = await book(receptionist, await payload(patientId, { reason: 'Motif autre site', siteId: siteB }, slot(0, 30, 40)));
      const viewer = await createUserWithPermissions(app, a, ['appointments:appointment:read']);
      await grantScoped(app, a, viewer.userId, ['consultations:consultation:read'], { scopeType: 'site', scopeId: a.mainSiteId });

      const getIn = await http().get(`/api/v1/appointments/${inScope['id']}`).set(auth(viewer)).expect(200);
      const getOut = await http().get(`/api/v1/appointments/${outOfScope['id']}`).set(auth(viewer)).expect(200);
      const list = await http().get('/api/v1/appointments').query({ from: slot(0, 30, 40).startsAt, to: slot(60, 30, 40).endsAt }).set(auth(viewer)).expect(200);

      expect(getIn.body.data).toMatchObject({ reason: 'Motif site principal' });
      expect(getOut.body.data).not.toHaveProperty('reason');
      expect(getOut.body.data).not.toHaveProperty('cancelReason');
      const byId = new Map((list.body.data as Record<string, any>[]).map((row) => [row['id'], row]));
      expect(byId.get(inScope['id'])).toHaveProperty('reason', 'Motif site principal');
      expect(byId.get(outOfScope['id'])).not.toHaveProperty('reason');
      expect(JSON.stringify(list.body)).not.toContain('Motif autre site');
    });
  });

  describe('périmètre patient à la prise de RDV (point 5)', () => {
    let patientInSite: string;
    let patientOtherSite: string;
    let booker: UserFixture;

    beforeAll(async () => {
      patientInSite = await createPatientRow(app, a, { primarySiteId: a.mainSiteId });
      patientOtherSite = await createPatientRow(app, a, { primarySiteId: siteB });
      booker = await createUserWithPermissions(app, a, BOOKING_PERMISSIONS);
      await grantScoped(app, a, booker.userId, ['patients:patient:read'], { scopeType: 'site', scopeId: a.mainSiteId });
    });

    it('traite un patient hors périmètre comme un patient inexistant à la création (même 422, même corps)', async () => {
      const outOfScope = await http().post('/api/v1/appointments').set(auth(booker)).send(await payload(patientOtherSite)).expect(422);
      const unknown = await http().post('/api/v1/appointments').set(auth(booker)).send(await payload(UNKNOWN_ID)).expect(422);

      expect(outOfScope.body.code).toBe(unknown.body.code);
      expect(outOfScope.body.errors).toEqual(unknown.body.errors);
      expect(outOfScope.body.errors[0]).toMatchObject({ path: 'patientId', code: 'not_found' });
      await http().post('/api/v1/appointments').set(auth(booker)).send(await payload(patientInSite)).expect(201);
    });

    it('refuse de reprogrammer, avec 404, le rendez-vous d’un patient hors du périmètre patient du demandeur', async () => {
      const appointment = await book(receptionist, await payload(patientOtherSite, {}, slot(0, 30, 41)));
      const own = await book(receptionist, await payload(patientInSite, {}, slot(0, 30, 41)));

      await http().patch(`/api/v1/appointments/${appointment['id']}/reschedule`).set(auth(booker)).send(slot(120, 30, 41)).expect(404);
      await http().patch(`/api/v1/appointments/${own['id']}/reschedule`).set(auth(booker)).send(slot(120, 30, 41)).expect(200);
    });
  });

  describe('patient décédé en cours de consultation (point 6)', () => {
    it('permet de poursuivre (in_progress) puis de clôturer (completed) une consultation dont le patient est décédé entre-temps', async () => {
      const patientId = await createPatientRow(app, a);
      const created = await book(receptionist, await payload(patientId, {}, slot(0, 30, 42)));
      vi.spyOn(app.get(Clock), 'now').mockReturnValue(new Date(created['startsAt']));
      const status = (to: string) => http().post(`/api/v1/appointments/${created['id']}/status`).set(auth(receptionist)).send({ status: to });
      await status('checked_in').expect(200);
      await tenantDb.runAs(a.tenantId, (tx) => tx.patient.update({ where: { tenantId_id: { tenantId: a.tenantId, id: patientId } }, data: { deceasedAt: new Date() } }));

      const started = await status('in_progress').expect(200);
      const done = await status('completed').expect(200);

      expect(started.body.data.status).toBe('in_progress');
      expect(done.body.data.status).toBe('completed');
    });
  });

  describe('forme de AppointmentView.patient (point 9)', () => {
    it('renvoie fullName « Prénom NOM » et deceasedAt (null puis la date de décès)', async () => {
      const patientId = await createPatientRow(app, a);
      await tenantDb.runAs(a.tenantId, (tx) => tx.patient.update({ where: { tenantId_id: { tenantId: a.tenantId, id: patientId } }, data: { lastName: 'Diop-Ndiaye', firstName: 'Awa' } }));
      const created = await book(receptionist, await payload(patientId, {}, slot(0, 30, 43)));
      await tenantDb.runAs(a.tenantId, (tx) => tx.patient.update({ where: { tenantId_id: { tenantId: a.tenantId, id: patientId } }, data: { deceasedAt: new Date('2027-01-02T10:00:00Z') } }));

      const fetched = await http().get(`/api/v1/appointments/${created['id']}`).set(auth(receptionist)).expect(200);

      expect(created['patient']).toMatchObject({ fullName: 'Awa DIOP-NDIAYE', deceasedAt: null });
      expect(fetched.body.data.patient).toMatchObject({ fullName: 'Awa DIOP-NDIAYE', deceasedAt: '2027-01-02T10:00:00.000Z' });
    });
  });
});
