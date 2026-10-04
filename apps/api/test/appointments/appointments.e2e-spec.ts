import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Clock } from '../../src/common/time/clock';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { createTenantFixture, createUserWithPermissions, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { createReceptionistWith } from '../patients/patient-fixtures';
import { createDepartmentRow, createPatientRow, createPractitionerRow, createSite, slot } from './appointment-fixtures';

const UNKNOWN_ID = '018f0000-0000-7000-8000-000000000000';

describe('rendez-vous (HTTP)', () => {
  let app: INestApplication;
  let tenantDb: TenantDb;
  let a: TenantFixture;
  let b: TenantFixture;
  let siteB: string;
  let receptionist: UserFixture;
  let siteScopedReceptionist: UserFixture;
  let doctor: UserFixture;
  let stockManager: UserFixture;
  let remover: UserFixture;
  let otherReceptionist: UserFixture;
  let patientId: string;

  const http = () => request(app.getHttpServer());
  const auth = (user: UserFixture) => ({ Authorization: `Bearer ${user.token}` });

  /** Corps de création sur un praticien neuf (aucun chevauchement entre tests). */
  async function body(overrides: Record<string, unknown> = {}, range = slot(0)) {
    return { patientId, practitionerId: await createPractitionerRow(app, a), siteId: a.mainSiteId, ...range, ...overrides };
  }

  async function book(user: UserFixture, payload: Record<string, unknown>) {
    const res = await http().post('/api/v1/appointments').set(auth(user)).send(payload).expect(201);
    return res.body.data as Record<string, any>;
  }

  const setStatus = (user: UserFixture, id: string, status: string, extra: Record<string, unknown> = {}) =>
    http().post(`/api/v1/appointments/${id}/status`).set(auth(user)).send({ status, ...extra });

  beforeAll(async () => {
    app = await createTestApp();
    tenantDb = app.get(TenantDb);
    [a, b] = await Promise.all([createTenantFixture(app, { prefix: 'rdv-a' }), createTenantFixture(app, { prefix: 'rdv-b' })]);
    siteB = await createSite(app, a, 'SITE-B');
    receptionist = await createUserWithRole(app, a, 'receptionist');
    siteScopedReceptionist = await createUserWithRole(app, a, 'receptionist', { scopeType: 'site', scopeId: a.mainSiteId });
    doctor = await createUserWithRole(app, a, 'doctor');
    stockManager = await createUserWithRole(app, a, 'stock_manager');
    remover = await createReceptionistWith(app, a, ['appointments:appointment:delete']);
    otherReceptionist = await createUserWithRole(app, b, 'receptionist');
    patientId = await createPatientRow(app, a);
  });

  afterAll(async () => {
    await app?.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Fige l'horloge de l'application (règles « après l'heure » et « jour J »). */
  const clockAt = (instant: string | Date): void => {
    vi.spyOn(app.get(Clock), 'now').mockReturnValue(new Date(instant));
  };

  describe('création', () => {
    it('crée un rendez-vous au statut scheduled et l’audite', async () => {
      const payload = await body({ reason: 'Consultation', source: 'phone' });

      const created = await book(receptionist, payload);
      const log = await tenantDb.runAs(a.tenantId, (tx) =>
        tx.auditLog.findFirstOrThrow({ where: { action: 'appointment.created', resourceId: created['id'] } }),
      );

      expect(created).toMatchObject({ status: 'scheduled', source: 'phone', patientId, siteId: a.mainSiteId, rowVersion: 1 });
      expect(created).not.toHaveProperty('reason');
      expect(created['startsAt']).toBe(payload.startsAt);
      expect(log.patientId).toBe(patientId);
      expect(JSON.stringify(log.changes)).not.toContain('Consultation');
    });

    it('refuse avec 409 slot_unavailable un chevauchement pour le même praticien', async () => {
      const payload = await body({}, slot(0, 60));
      await book(receptionist, payload);

      const res = await http().post('/api/v1/appointments').set(auth(receptionist)).send({ ...payload, ...slot(30, 30) }).expect(409);

      expect(res.body.code).toBe('slot_unavailable');
    });

    it('accepte des créneaux contigus (fin = début suivant) pour le même praticien', async () => {
      const payload = await body({}, slot(0, 30));
      await book(receptionist, payload);

      await http().post('/api/v1/appointments').set(auth(receptionist)).send({ ...payload, ...slot(30, 30) }).expect(201);
    });

    it('accepte le même créneau pour deux praticiens différents', async () => {
      await book(receptionist, await body({}, slot(0)));

      await book(receptionist, await body({}, slot(0)));
    });

    it('libère le créneau quand le rendez-vous est annulé', async () => {
      const payload = await body();
      const first = await book(receptionist, payload);
      await setStatus(receptionist, first['id'], 'cancelled', { cancelReason: 'Patient indisponible' }).expect(200);

      await http().post('/api/v1/appointments').set(auth(receptionist)).send(payload).expect(201);
    });

    it('garantit un seul gagnant pour deux réservations simultanées du même créneau', async () => {
      const payload = await body();

      const results = await Promise.all([
        http().post('/api/v1/appointments').set(auth(receptionist)).send(payload),
        http().post('/api/v1/appointments').set(auth(doctor)).send(payload),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    });

    it.each([
      ['fin avant début', { startsAt: slot(60).startsAt, endsAt: slot(0).startsAt }],
      ['fin égale au début', { startsAt: slot(0).startsAt, endsAt: slot(0).startsAt }],
      ['date non ISO', { startsAt: 'demain' }],
      ['source inconnue', { source: 'pigeon' }],
      ['motif trop long', { reason: 'x'.repeat(501) }],
    ])('refuse avec 422 : %s', async (_label, overrides) => {
      const res = await http().post('/api/v1/appointments').set(auth(receptionist)).send(await body(overrides)).expect(422);

      expect(res.body.code).toBe('validation_failed');
    });

    it.each([
      ['patientId', { patientId: UNKNOWN_ID }],
      ['practitionerId', { practitionerId: UNKNOWN_ID }],
      ['siteId', { siteId: UNKNOWN_ID }],
    ])('refuse avec 422 un %s inexistant', async (path, overrides) => {
      const res = await http().post('/api/v1/appointments').set(auth(receptionist)).send(await body(overrides)).expect(422);

      expect(res.body.errors[0].path).toBe(path);
    });

    it('refuse avec 422 un patient, un praticien ou un site d’un autre tenant', async () => {
      const foreignPatient = await createPatientRow(app, b);
      const foreignPractitioner = await createPractitionerRow(app, b);

      await http().post('/api/v1/appointments').set(auth(receptionist)).send(await body({ patientId: foreignPatient })).expect(422);
      await http().post('/api/v1/appointments').set(auth(receptionist)).send(await body({ practitionerId: foreignPractitioner })).expect(422);
      await http().post('/api/v1/appointments').set(auth(receptionist)).send(await body({ siteId: b.mainSiteId })).expect(422);
    });

    it('refuse avec 422 practitioner_not_bookable un praticien non réservable', async () => {
      const practitionerId = await createPractitionerRow(app, a, { isBookable: false });

      const res = await http().post('/api/v1/appointments').set(auth(receptionist)).send(await body({ practitionerId })).expect(422);

      expect(res.body.code).toBe('practitioner_not_bookable');
    });

    it('refuse avec 403 un site hors de la portée de l’utilisateur', async () => {
      const res = await http().post('/api/v1/appointments').set(auth(siteScopedReceptionist)).send(await body({ siteId: siteB })).expect(403);

      expect(res.body.code).toBe('site_out_of_scope');
    });

    it('accepte la création dans le site de la portée de l’utilisateur', async () => {
      await book(siteScopedReceptionist, await body({ siteId: a.mainSiteId }));
    });

    it('autorise un service rattaché au praticien à couvrir un site hors portée de site', async () => {
      const departmentId = await createDepartmentRow(app, a, siteB);
      const practitionerId = await createPractitionerRow(app, a, { departmentId });
      const departmentScoped = await createUserWithRole(app, a, 'receptionist', { scopeType: 'department', scopeId: departmentId });

      await book(departmentScoped, await body({ practitionerId, siteId: siteB }));
    });
  });

  describe('autorisations et isolation', () => {
    it('refuse avec 403 un rôle sans permission rendez-vous (stock_manager)', async () => {
      await http().get('/api/v1/appointments').query(slot(0)).set(auth(stockManager)).expect(403);
      await http().post('/api/v1/appointments').set(auth(stockManager)).send(await body()).expect(403);
    });

    it('refuse avec 401 sans jeton', async () => {
      await http().get('/api/v1/appointments').expect(401);
    });

    it('renvoie 404 pour un rendez-vous d’un autre tenant (lecture, reprogrammation, statut, suppression)', async () => {
      const foreign = await book(otherReceptionist, {
        patientId: await createPatientRow(app, b),
        practitionerId: await createPractitionerRow(app, b),
        siteId: b.mainSiteId,
        ...slot(0),
      });
      const id = foreign['id'];

      await http().get(`/api/v1/appointments/${id}`).set(auth(receptionist)).expect(404);
      await http().patch(`/api/v1/appointments/${id}/reschedule`).set(auth(receptionist)).send(slot(120)).expect(404);
      await setStatus(receptionist, id, 'confirmed').expect(404);
      await http().delete(`/api/v1/appointments/${id}`).set(auth(remover)).expect(404);
    });

    it('renvoie 404 pour un identifiant mal formé', async () => {
      await http().get('/api/v1/appointments/pas-un-uuid').set(auth(receptionist)).expect(404);
    });

    it('lit le détail d’un rendez-vous du tenant', async () => {
      const created = await book(receptionist, await body());

      const res = await http().get(`/api/v1/appointments/${created['id']}`).set(auth(doctor)).expect(200);

      expect(res.body.data).toMatchObject({ id: created['id'], status: 'scheduled' });
      expect(res.body.data).not.toHaveProperty('tenantId');
    });
  });

  describe('liste et portée de site', () => {
    it('filtre par intervalle, praticien, statut et patient', async () => {
      const practitionerId = await createPractitionerRow(app, a);
      const otherPatient = await createPatientRow(app, a);
      const day = 200;
      const inRange = await book(receptionist, { patientId, practitionerId, siteId: a.mainSiteId, ...slot(0, 30, day) });
      const confirmed = await book(receptionist, { patientId: otherPatient, practitionerId, siteId: a.mainSiteId, ...slot(60, 30, day) });
      await setStatus(receptionist, confirmed['id'], 'confirmed').expect(200);
      await book(receptionist, { patientId, practitionerId, siteId: a.mainSiteId, ...slot(0, 30, day + 3) });
      const query = { from: slot(-60, 0, day).startsAt, to: slot(24 * 60, 0, day).startsAt };
      const ids = async (extra: Record<string, string>) =>
        (await http().get('/api/v1/appointments').query({ ...query, practitionerId, ...extra }).set(auth(receptionist)).expect(200)).body.data.map((r: { id: string }) => r.id);

      expect(await ids({})).toEqual([inRange['id'], confirmed['id']]);
      expect(await ids({ status: 'confirmed' })).toEqual([confirmed['id']]);
      expect(await ids({ patientId: otherPatient })).toEqual([confirmed['id']]);
      expect(await ids({ siteId: siteB })).toEqual([]);
    });

    it('pagine par curseur sans doublon ni oubli', async () => {
      const practitionerId = await createPractitionerRow(app, a);
      const day = 300;
      for (const minute of [0, 30, 60]) await book(receptionist, { patientId, practitionerId, siteId: a.mainSiteId, ...slot(minute, 30, day) });
      const query = { from: slot(-60, 0, day).startsAt, to: slot(24 * 60, 0, day).startsAt, practitionerId, limit: 2 };

      const page1 = await http().get('/api/v1/appointments').query(query).set(auth(receptionist)).expect(200);
      const page2 = await http().get('/api/v1/appointments').query({ ...query, cursor: page1.body.meta.pagination.nextCursor }).set(auth(receptionist)).expect(200);

      expect(page1.body.data).toHaveLength(2);
      expect(page1.body.meta.pagination.hasMore).toBe(true);
      expect(page2.body.data).toHaveLength(1);
      expect(new Set([...page1.body.data, ...page2.body.data].map((r: { id: string }) => r.id)).size).toBe(3);
    });

    it('refuse avec 422 un curseur invalide', async () => {
      const query = { from: slot(0).startsAt, to: slot(60).endsAt, cursor: 'bidon' };

      await http().get('/api/v1/appointments').query(query).set(auth(receptionist)).expect(422);
    });

    it('limite les résultats aux sites couverts par la permission', async () => {
      const day = 400;
      const inScope = await book(receptionist, await body({ siteId: a.mainSiteId }, slot(0, 30, day)));
      const outOfScope = await book(receptionist, await body({ siteId: siteB }, slot(0, 30, day)));
      const query = { from: slot(-60, 0, day).startsAt, to: slot(24 * 60, 0, day).startsAt };

      const scoped = await http().get('/api/v1/appointments').query(query).set(auth(siteScopedReceptionist)).expect(200);
      const full = await http().get('/api/v1/appointments').query(query).set(auth(receptionist)).expect(200);

      const scopedIds = scoped.body.data.map((r: { id: string }) => r.id);
      expect(scopedIds).toContain(inScope['id']);
      expect(scopedIds).not.toContain(outOfScope['id']);
      expect(full.body.data.map((r: { id: string }) => r.id)).toEqual(expect.arrayContaining([inScope['id'], outOfScope['id']]));
    });

    it('renvoie 404 pour le détail et les actions sur un rendez-vous hors portée de site', async () => {
      const outOfScope = await book(receptionist, await body({ siteId: siteB }));
      const url = `/api/v1/appointments/${outOfScope['id']}`;

      await http().get(url).set(auth(siteScopedReceptionist)).expect(404);
      await http().patch(`${url}/reschedule`).set(auth(siteScopedReceptionist)).send(slot(240)).expect(404);
      await setStatus(siteScopedReceptionist, outOfScope['id'], 'confirmed').expect(404);
      const scopedRemover = await createUserWithPermissions(app, a, ['appointments:appointment:delete'], { scopeType: 'site', scopeId: a.mainSiteId });
      await http().delete(url).set(auth(scopedRemover)).expect(404);
    });

    it.each([
      ['from manquant', { to: slot(0).endsAt }],
      ['to manquant', { from: slot(0).startsAt }],
      ['intervalle supérieur à 31 jours', { from: slot(0).startsAt, to: slot(0, 30, 32).startsAt }],
      ['to antérieur à from', { from: slot(60).startsAt, to: slot(0).startsAt }],
      ['statut inconnu', { from: slot(0).startsAt, to: slot(60).startsAt, status: 'zombie' }],
    ])('refuse avec 422 : %s', async (_label, query) => {
      const res = await http().get('/api/v1/appointments').query(query).set(auth(receptionist)).expect(422);

      expect(res.body.code).toBe('validation_failed');
    });

    it('accepte un intervalle d’exactement 31 jours', async () => {
      await http().get('/api/v1/appointments').query({ from: slot(0).startsAt, to: slot(0, 30, 31).startsAt }).set(auth(receptionist)).expect(200);
    });
  });

  describe('reprogrammation', () => {
    it('déplace le rendez-vous, incrémente la version et l’audite', async () => {
      const created = await book(receptionist, await body());

      const res = await http().patch(`/api/v1/appointments/${created['id']}/reschedule`).set(auth(receptionist)).send(slot(180, 45)).expect(200);
      const log = await tenantDb.runAs(a.tenantId, (tx) =>
        tx.auditLog.findFirstOrThrow({ where: { action: 'appointment.rescheduled', resourceId: created['id'] } }),
      );

      expect(res.body.data).toMatchObject({ ...slot(180, 45), rowVersion: 2, status: 'scheduled' });
      expect(log.changes).toEqual({ fields: ['startsAt', 'endsAt'] });
    });

    it('refuse avec 409 slot_unavailable un déplacement sur un créneau occupé', async () => {
      const payload = await body({}, slot(0));
      await book(receptionist, { ...payload, ...slot(60) });
      const movable = await book(receptionist, payload);

      const res = await http().patch(`/api/v1/appointments/${movable['id']}/reschedule`).set(auth(receptionist)).send(slot(60)).expect(409);

      expect(res.body.code).toBe('slot_unavailable');
    });

    it('refuse avec 409 invalid_transition la reprogrammation d’un rendez-vous annulé', async () => {
      const created = await book(receptionist, await body());
      await setStatus(receptionist, created['id'], 'cancelled', { cancelReason: 'Annulé' }).expect(200);

      const res = await http().patch(`/api/v1/appointments/${created['id']}/reschedule`).set(auth(receptionist)).send(slot(60)).expect(409);

      expect(res.body.code).toBe('invalid_transition');
    });

    it('refuse avec 422 une fin antérieure au début', async () => {
      const created = await book(receptionist, await body());

      await http()
        .patch(`/api/v1/appointments/${created['id']}/reschedule`)
        .set(auth(receptionist))
        .send({ startsAt: slot(60).startsAt, endsAt: slot(0).startsAt })
        .expect(422);
    });
  });

  describe('machine à états', () => {
    it('parcourt le cycle complet scheduled, confirmed, checked_in, in_progress, completed', async () => {
      const created = await book(receptionist, await body());
      const id = created['id'];
      clockAt(created['startsAt']);

      const confirmed = await setStatus(receptionist, id, 'confirmed').expect(200);
      const checkedIn = await setStatus(receptionist, id, 'checked_in').expect(200);
      const inProgress = await setStatus(doctor, id, 'in_progress').expect(200);
      const completed = await setStatus(doctor, id, 'completed').expect(200);

      expect(confirmed.body.data.status).toBe('confirmed');
      expect(confirmed.body.data.checkedInAt).toBeNull();
      expect(checkedIn.body.data.status).toBe('checked_in');
      expect(checkedIn.body.data.checkedInAt).toBe(new Date(created['startsAt']).toISOString());
      expect(inProgress.body.data.status).toBe('in_progress');
      expect(completed.body.data.status).toBe('completed');
    });

    it('autorise l’arrivée directe depuis scheduled et le statut no_show', async () => {
      const arrived = await book(receptionist, await body());
      const absent = await book(receptionist, await body());
      clockAt(new Date(Date.parse(arrived['startsAt']) + 60 * 60_000));

      await setStatus(receptionist, arrived['id'], 'checked_in').expect(200);
      const res = await setStatus(receptionist, absent['id'], 'no_show').expect(200);

      expect(res.body.data.status).toBe('no_show');
    });

    it.each([
      ['scheduled', 'completed'],
      ['scheduled', 'in_progress'],
      ['scheduled', 'scheduled'],
    ])('refuse avec 409 invalid_transition : %s vers %s', async (_from, to) => {
      const created = await book(receptionist, await body());

      const res = await setStatus(receptionist, created['id'], to).expect(409);

      expect(res.body.code).toBe('invalid_transition');
    });

    it('refuse toute sortie d’un statut terminal', async () => {
      const created = await book(receptionist, await body());
      await setStatus(receptionist, created['id'], 'cancelled', { cancelReason: 'Annulé' }).expect(200);

      const res = await setStatus(receptionist, created['id'], 'confirmed').expect(409);

      expect(res.body.code).toBe('invalid_transition');
    });

    it('exige cancelReason pour annuler (422) puis l’enregistre', async () => {
      const created = await book(receptionist, await body());

      const missing = await setStatus(receptionist, created['id'], 'cancelled').expect(422);
      const blank = await setStatus(receptionist, created['id'], 'cancelled', { cancelReason: '   ' }).expect(422);
      const ok = await setStatus(doctor, created['id'], 'cancelled', { cancelReason: 'Décès dans la famille' }).expect(200);
      const hidden = await http().get(`/api/v1/appointments/${created['id']}`).set(auth(receptionist)).expect(200);

      expect(missing.body.errors[0].path).toBe('cancelReason');
      expect(blank.body.code).toBe('validation_failed');
      expect(ok.body.data).toMatchObject({ status: 'cancelled', cancelReason: 'Décès dans la famille' });
      expect(hidden.body.data).not.toHaveProperty('cancelReason');
    });

    it('refuse avec 422 un statut inconnu', async () => {
      const created = await book(receptionist, await body());

      await setStatus(receptionist, created['id'], 'zombie').expect(422);
    });

    it('audite le changement de statut sans le motif d’annulation', async () => {
      const created = await book(receptionist, await body());
      await setStatus(receptionist, created['id'], 'cancelled', { cancelReason: 'Motif confidentiel' }).expect(200);

      const log = await tenantDb.runAs(a.tenantId, (tx) =>
        tx.auditLog.findFirstOrThrow({ where: { action: 'appointment.status_changed', resourceId: created['id'] } }),
      );

      expect(log.changes).toEqual({ from: 'scheduled', to: 'cancelled' });
    });

    it('refuse avec 403 le changement de statut à un rôle sans permission update', async () => {
      const created = await book(receptionist, await body());
      const director = await createUserWithRole(app, a, 'director');

      await setStatus(director, created['id'], 'confirmed').expect(403);
    });
  });

  describe('suppression logique', () => {
    it('supprime logiquement : 204, puis 404, ligne conservée, créneau libéré', async () => {
      const payload = await body();
      const created = await book(receptionist, payload);

      await http().delete(`/api/v1/appointments/${created['id']}`).set(auth(remover)).expect(204);
      await http().get(`/api/v1/appointments/${created['id']}`).set(auth(receptionist)).expect(404);
      const stored = await tenantDb.runAs(a.tenantId, (tx) => tx.appointment.findFirst({ where: { id: created['id'] } }));
      await http().post('/api/v1/appointments').set(auth(receptionist)).send(payload).expect(201);

      expect(stored?.deletedAt).toBeInstanceOf(Date);
    });

    it('refuse avec 403 sans la permission appointments:appointment:delete', async () => {
      const created = await book(receptionist, await body());

      await http().delete(`/api/v1/appointments/${created['id']}`).set(auth(doctor)).expect(403);
      await http().delete(`/api/v1/appointments/${created['id']}`).set(auth(receptionist)).expect(403);
    });
  });

  describe('rôles corrigés (A11)', () => {
    it('refuse la lecture des rendez-vous au directeur (agrégats seulement) et la suppression au réceptionniste et à l’agent administratif', async () => {
      const director = await createUserWithRole(app, a, 'director');
      const adminAgent = await createUserWithRole(app, a, 'admin_agent');
      const created = await book(receptionist, await body());

      await http().get('/api/v1/appointments').query({ from: slot(0).startsAt, to: slot(60).endsAt }).set(auth(director)).expect(403);
      await http().get(`/api/v1/appointments/${created['id']}`).set(auth(director)).expect(403);
      await http().delete(`/api/v1/appointments/${created['id']}`).set(auth(receptionist)).expect(403);
      await http().delete(`/api/v1/appointments/${created['id']}`).set(auth(adminAgent)).expect(403);
      await http().get(`/api/v1/appointments/${created['id']}`).set(auth(adminAgent)).expect(200);
    });
  });

  describe('forme AppointmentView (A2/A3)', () => {
    it('inclut le patient (id, ipp, fullName, birthYear) et le praticien (id, fullName, specialty)', async () => {
      const knownPatient = await createPatientRow(app, a, { birthDate: new Date('1988-07-14T00:00:00Z') });
      const practitionerId = await createPractitionerRow(app, a);
      const created = await book(receptionist, { patientId: knownPatient, practitionerId, siteId: a.mainSiteId, ...slot(0) });

      const detail = await http().get(`/api/v1/appointments/${created['id']}`).set(auth(receptionist)).expect(200);
      const list = await http().get('/api/v1/appointments').query({ from: slot(-60).startsAt, to: slot(120).startsAt, practitionerId }).set(auth(receptionist)).expect(200);

      for (const view of [created, detail.body.data, list.body.data[0]]) {
        expect(view.patient).toEqual({ id: knownPatient, ipp: expect.stringMatching(/^TEST-/), fullName: expect.stringMatching(/^Patient RDV[0-9A-F]{8}$/), birthYear: 1988, deceasedAt: null });
        expect(view.practitioner).toEqual({ id: practitionerId, fullName: expect.stringMatching(/^Dr /), specialty: null });
      }
      expect(JSON.stringify(detail.body)).not.toMatch(/phone|email|nationalId|address|birthDate/);
    });

    it('renvoie birthYear null quand la date de naissance est inconnue', async () => {
      const created = await book(receptionist, await body());

      expect(created['patient'].birthYear).toBeNull();
    });

    it('ne renvoie reason et cancelReason qu’avec consultations:consultation:read', async () => {
      const practitionerId = await createPractitionerRow(app, a);
      const created = await book(receptionist, { patientId, practitionerId, siteId: a.mainSiteId, reason: 'Douleur thoracique', ...slot(0) });
      await setStatus(doctor, created['id'], 'cancelled', { cancelReason: 'Patient hospitalisé' }).expect(200);
      const query = { from: slot(-60).startsAt, to: slot(120).startsAt, practitionerId };

      const asDoctor = await http().get(`/api/v1/appointments/${created['id']}`).set(auth(doctor)).expect(200);
      const asReceptionist = await http().get(`/api/v1/appointments/${created['id']}`).set(auth(receptionist)).expect(200);
      const listDoctor = await http().get('/api/v1/appointments').query(query).set(auth(doctor)).expect(200);
      const listReceptionist = await http().get('/api/v1/appointments').query(query).set(auth(receptionist)).expect(200);
      const createdByDoctor = await book(doctor, await body({ reason: 'Contrôle' }));

      expect(asDoctor.body.data).toMatchObject({ reason: 'Douleur thoracique', cancelReason: 'Patient hospitalisé' });
      expect(listDoctor.body.data[0]).toMatchObject({ reason: 'Douleur thoracique' });
      expect(createdByDoctor).toMatchObject({ reason: 'Contrôle', cancelReason: null });
      for (const view of [asReceptionist.body.data, listReceptionist.body.data[0]]) {
        expect(view).not.toHaveProperty('reason');
        expect(view).not.toHaveProperty('cancelReason');
      }
      expect(JSON.stringify([asReceptionist.body, listReceptionist.body])).not.toMatch(/Douleur thoracique|Patient hospitalisé/);
    });
  });

  describe('audit des lectures (A7)', () => {
    it('trace appointment.listed avec les patientIds de la page, sans le motif', async () => {
      const practitionerId = await createPractitionerRow(app, a);
      const otherPatient = await createPatientRow(app, a);
      await book(receptionist, { patientId, practitionerId, siteId: a.mainSiteId, reason: 'Secret médical', ...slot(0, 30, 500) });
      await book(receptionist, { patientId: otherPatient, practitionerId, siteId: a.mainSiteId, ...slot(60, 30, 500) });

      await http().get('/api/v1/appointments').query({ from: slot(-60, 0, 500).startsAt, to: slot(24 * 60, 0, 500).startsAt, practitionerId }).set(auth(receptionist)).expect(200);

      const log = await tenantDb.runAs(a.tenantId, (tx) =>
        tx.auditLog.findFirstOrThrow({ where: { action: 'appointment.listed', actorUserId: receptionist.userId }, orderBy: { chainSeq: 'desc' } }),
      );
      expect((log.changes as { patientIds: string[] }).patientIds.sort()).toEqual([patientId, otherPatient].sort());
      expect(log.changes).toMatchObject({ resultCount: 2 });
      expect(JSON.stringify(log.changes)).not.toContain('Secret médical');
    });

    it('trace appointment.read avec l’identifiant du rendez-vous et du patient', async () => {
      const created = await book(receptionist, await body());

      await http().get(`/api/v1/appointments/${created['id']}`).set(auth(doctor)).expect(200);

      const log = await tenantDb.runAs(a.tenantId, (tx) =>
        tx.auditLog.findFirstOrThrow({ where: { action: 'appointment.read', resourceId: created['id'] } }),
      );
      expect(log).toMatchObject({ patientId, actorUserId: doctor.userId, outcome: 'success' });
    });
  });

  describe('règles de la machine à états (A10)', () => {
    it('refuse no_show avant l’heure de début (409) et l’accepte après', async () => {
      const created = await book(receptionist, await body());

      clockAt(new Date(Date.parse(created['startsAt']) - 60_000));
      const early = await setStatus(receptionist, created['id'], 'no_show').expect(409);
      clockAt(created['startsAt']);
      const onTime = await setStatus(receptionist, created['id'], 'no_show').expect(200);

      expect(early.body.code).toBe('invalid_transition');
      expect(onTime.body.data.status).toBe('no_show');
    });

    it('refuse checked_in un autre jour que le jour J (fuseau du tenant) et l’accepte le jour J', async () => {
      const created = await book(receptionist, await body());
      const startsAt = Date.parse(created['startsAt']);

      clockAt(new Date(startsAt - 24 * 3_600_000));
      const dayBefore = await setStatus(receptionist, created['id'], 'checked_in').expect(409);
      clockAt(new Date(startsAt + 24 * 3_600_000));
      await setStatus(receptionist, created['id'], 'checked_in').expect(409);
      clockAt(new Date(startsAt - 2 * 3_600_000));
      await setStatus(receptionist, created['id'], 'checked_in').expect(200);

      expect(dayBefore.body.code).toBe('invalid_transition');
    });

    it('ne supprime que les rendez-vous scheduled ou confirmed (409 sinon)', async () => {
      const confirmed = await book(receptionist, await body());
      await setStatus(receptionist, confirmed['id'], 'confirmed').expect(200);
      const arrived = await book(receptionist, await body());
      clockAt(arrived['startsAt']);
      await setStatus(receptionist, arrived['id'], 'checked_in').expect(200);
      const cancelled = await book(receptionist, await body());
      await setStatus(receptionist, cancelled['id'], 'cancelled', { cancelReason: 'Annulé' }).expect(200);

      const refusedArrived = await http().delete(`/api/v1/appointments/${arrived['id']}`).set(auth(remover)).expect(409);
      await http().delete(`/api/v1/appointments/${cancelled['id']}`).set(auth(remover)).expect(409);
      await http().delete(`/api/v1/appointments/${confirmed['id']}`).set(auth(remover)).expect(204);

      expect(refusedArrived.body.code).toBe('invalid_transition');
    });

    it('refuse un créneau dans le passé à la création et à la reprogrammation (422 slot_in_past)', async () => {
      const created = await book(receptionist, await body());
      const past = slot(-60 * 24 * 365 * 2);

      const onCreate = await http().post('/api/v1/appointments').set(auth(receptionist)).send(await body({}, past)).expect(422);
      const onReschedule = await http().patch(`/api/v1/appointments/${created['id']}/reschedule`).set(auth(receptionist)).send(past).expect(422);

      expect(onCreate.body.code).toBe('slot_in_past');
      expect(onReschedule.body.code).toBe('slot_in_past');
    });

    it('refuse un patient décédé : création, reprogrammation et arrivée (422 patient_deceased)', async () => {
      const alive = await book(receptionist, await body());
      const deceasedId = await createPatientRow(app, a);
      await book(receptionist, await body({ patientId: deceasedId }));
      const scheduledBefore = await book(receptionist, await body({ patientId: deceasedId }, slot(300)));
      await tenantDb.runAs(a.tenantId, (tx) => tx.patient.update({ where: { tenantId_id: { tenantId: a.tenantId, id: deceasedId } }, data: { deceasedAt: new Date() } }));
      clockAt(scheduledBefore['startsAt']);

      const onCreate = await http().post('/api/v1/appointments').set(auth(receptionist)).send(await body({ patientId: deceasedId })).expect(422);
      const onReschedule = await http().patch(`/api/v1/appointments/${scheduledBefore['id']}/reschedule`).set(auth(receptionist)).send(slot(400)).expect(422);
      const onCheckIn = await setStatus(receptionist, scheduledBefore['id'], 'checked_in').expect(422);
      await setStatus(receptionist, scheduledBefore['id'], 'cancelled', { cancelReason: 'Patient décédé' }).expect(200);

      for (const res of [onCreate, onReschedule, onCheckIn]) expect(res.body.code).toBe('patient_deceased');
      await http().patch(`/api/v1/appointments/${alive['id']}/reschedule`).set(auth(receptionist)).send(slot(500)).expect(200);
    });

    it('refuse avec 422 un curseur dont l’identifiant n’est pas un UUID (L3)', async () => {
      const cursor = Buffer.from(`${slot(0).startsAt}|pas-un-uuid`).toString('base64url');

      const res = await http().get('/api/v1/appointments').query({ from: slot(0).startsAt, to: slot(60).endsAt, cursor }).set(auth(receptionist)).expect(422);

      expect(res.body.errors[0].path).toBe('cursor');
    });
  });

  describe('module désactivé', () => {
    it('refuse avec 403 module_not_enabled toutes les routes rendez-vous', async () => {
      const tenant = await createTenantFixture(app, { prefix: 'rdv-off', optionalModules: [] });
      const user = await createUserWithRole(app, tenant, 'receptionist');

      const list = await http().get('/api/v1/appointments').query(slot(0)).set(auth(user)).expect(403);
      const create = await http().post('/api/v1/appointments').set(auth(user)).send(await body()).expect(403);

      expect(list.body.code).toBe('module_not_enabled');
      expect(create.body.code).toBe('module_not_enabled');
    });
  });
});
