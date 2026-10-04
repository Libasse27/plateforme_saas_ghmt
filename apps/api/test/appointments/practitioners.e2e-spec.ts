import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { createTenantFixture, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { createDepartmentRow } from './appointment-fixtures';

const UNKNOWN_ID = '018f0000-0000-7000-8000-000000000000';

describe('praticiens (HTTP)', () => {
  let app: INestApplication;
  let a: TenantFixture;
  let b: TenantFixture;
  let receptionist: UserFixture;
  let doctor: UserFixture;
  let stockManager: UserFixture;
  let otherReceptionist: UserFixture;

  const http = () => request(app.getHttpServer());
  const auth = (user: UserFixture) => ({ Authorization: `Bearer ${user.token}` });

  async function createPractitioner(user: UserFixture, body: Record<string, unknown>) {
    const res = await http().post('/api/v1/practitioners').set(auth(user)).send(body).expect(201);
    return res.body.data as Record<string, any>;
  }

  beforeAll(async () => {
    app = await createTestApp();
    [a, b] = await Promise.all([createTenantFixture(app, { prefix: 'prac-a' }), createTenantFixture(app, { prefix: 'prac-b' })]);
    receptionist = await createUserWithRole(app, a, 'receptionist');
    doctor = await createUserWithRole(app, a, 'doctor');
    stockManager = await createUserWithRole(app, a, 'stock_manager');
    otherReceptionist = await createUserWithRole(app, b, 'receptionist');
  });

  afterAll(async () => {
    await app?.close();
  });

  it('refuse avec 422 un curseur qui n’est pas un UUID (L3)', async () => {
    for (const cursor of ['bidon', Buffer.from('pas-un-uuid').toString('base64url')]) {
      const res = await http().get('/api/v1/practitioners').query({ cursor }).set(auth(receptionist)).expect(422);
      expect(res.body.errors[0].path).toBe('cursor');
    }
  });

  it('crée un praticien avec les valeurs par défaut', async () => {
    const created = await createPractitioner(receptionist, { fullName: 'Dr Awa Sow', specialty: 'Pédiatrie' });

    expect(created).toMatchObject({ fullName: 'Dr Awa Sow', specialty: 'Pédiatrie', defaultConsultMinutes: 20, isBookable: true, rowVersion: 1 });
  });

  it('crée un praticien rattaché à un utilisateur, un service et un site du tenant', async () => {
    const departmentId = await createDepartmentRow(app, a, a.mainSiteId);

    const created = await createPractitioner(receptionist, { fullName: 'Dr Lié', userId: doctor.userId, departmentId, primarySiteId: a.mainSiteId });

    expect(created).toMatchObject({ userId: doctor.userId, departmentId, primarySiteId: a.mainSiteId });
  });

  it('lit un praticien et le retrouve dans la liste filtrée par disponibilité', async () => {
    const bookable = await createPractitioner(receptionist, { fullName: 'Dr Réservable' });
    const closed = await createPractitioner(receptionist, { fullName: 'Dr Fermé', isBookable: false });

    const one = await http().get(`/api/v1/practitioners/${bookable['id']}`).set(auth(doctor)).expect(200);
    const list = await http().get('/api/v1/practitioners').query({ isBookable: 'false' }).set(auth(doctor)).expect(200);

    expect(one.body.data.fullName).toBe('Dr Réservable');
    const ids = list.body.data.map((p: { id: string }) => p.id);
    expect(ids).toContain(closed['id']);
    expect(ids).not.toContain(bookable['id']);
  });

  it('pagine la liste par curseur', async () => {
    for (let i = 0; i < 3; i += 1) await createPractitioner(receptionist, { fullName: `Dr Pagination ${i}` });

    const page1 = await http().get('/api/v1/practitioners').query({ limit: 2 }).set(auth(receptionist)).expect(200);
    const page2 = await http().get('/api/v1/practitioners').query({ limit: 2, cursor: page1.body.meta.pagination.nextCursor }).set(auth(receptionist)).expect(200);

    expect(page1.body.meta.pagination.hasMore).toBe(true);
    const overlap = page1.body.data.filter((p: { id: string }) => page2.body.data.some((q: { id: string }) => q.id === p.id));
    expect(overlap).toEqual([]);
  });

  it('modifie un praticien et audite les champs sans valeurs', async () => {
    const created = await createPractitioner(receptionist, { fullName: 'Dr Avant' });

    const res = await http().patch(`/api/v1/practitioners/${created['id']}`).set(auth(receptionist)).send({ fullName: 'Dr Après', isBookable: false }).expect(200);
    const log = await app.get(TenantDb).runAs(a.tenantId, (tx) =>
      tx.auditLog.findFirstOrThrow({ where: { action: 'practitioner.updated', resourceId: created['id'] } }),
    );

    expect(res.body.data).toMatchObject({ fullName: 'Dr Après', isBookable: false, defaultConsultMinutes: 20, rowVersion: 2 });
    expect(log.changes).toEqual({ fields: ['fullName', 'isBookable'] });
  });

  it('refuse avec 422 un corps de modification vide', async () => {
    const created = await createPractitioner(receptionist, { fullName: 'Dr Vide' });

    await http().patch(`/api/v1/practitioners/${created['id']}`).set(auth(receptionist)).send({}).expect(422);
  });

  it('refuse avec 403 un rôle sans permission d’agenda (stock_manager)', async () => {
    await http().post('/api/v1/practitioners').set(auth(stockManager)).send({ fullName: 'Dr Intrus' }).expect(403);
    await http().get('/api/v1/practitioners').set(auth(stockManager)).expect(403);
  });

  it.each([
    ['nom trop court', { fullName: 'D' }],
    ['durée hors bornes', { fullName: 'Dr Durée', defaultConsultMinutes: 1 }],
    ['userId non UUID', { fullName: 'Dr Uuid', userId: 'abc' }],
  ])('refuse avec 422 : %s', async (_label, body) => {
    const res = await http().post('/api/v1/practitioners').set(auth(receptionist)).send(body).expect(422);

    expect(res.body.code).toBe('validation_failed');
  });

  it.each([
    ['userId', { userId: UNKNOWN_ID }],
    ['departmentId', { departmentId: UNKNOWN_ID }],
    ['primarySiteId', { primarySiteId: UNKNOWN_ID }],
  ])('refuse avec 422 un %s inexistant dans le tenant', async (path, ref) => {
    const res = await http().post('/api/v1/practitioners').set(auth(receptionist)).send({ fullName: 'Dr Référence', ...ref }).expect(422);

    expect(res.body.errors[0].path).toBe(path);
  });

  it('refuse avec 422 un site ou un utilisateur d’un autre tenant', async () => {
    await http().post('/api/v1/practitioners').set(auth(receptionist)).send({ fullName: 'Dr Croisé', primarySiteId: b.mainSiteId }).expect(422);
    await http().post('/api/v1/practitioners').set(auth(receptionist)).send({ fullName: 'Dr Croisé', userId: otherReceptionist.userId }).expect(422);
  });

  it('refuse avec 409 deux praticiens pour le même utilisateur', async () => {
    const user = await createUserWithRole(app, a, 'nurse');
    await createPractitioner(receptionist, { fullName: 'Dr Premier', userId: user.userId });

    const res = await http().post('/api/v1/practitioners').set(auth(receptionist)).send({ fullName: 'Dr Second', userId: user.userId }).expect(409);

    expect(res.body.code).toBe('duplicate');
  });

  it('renvoie 404 pour un praticien d’un autre tenant ou d’un identifiant mal formé', async () => {
    const foreign = await createPractitioner(otherReceptionist, { fullName: 'Dr Étranger' });

    await http().get(`/api/v1/practitioners/${foreign['id']}`).set(auth(receptionist)).expect(404);
    await http().patch(`/api/v1/practitioners/${foreign['id']}`).set(auth(receptionist)).send({ specialty: 'X' }).expect(404);
    await http().get('/api/v1/practitioners/xyz').set(auth(receptionist)).expect(404);
  });

  it('refuse avec 403 module_not_enabled quand le module rendez-vous est désactivé', async () => {
    const tenant = await createTenantFixture(app, { prefix: 'prac-off', optionalModules: [] });
    const user = await createUserWithRole(app, tenant, 'receptionist');

    const res = await http().get('/api/v1/practitioners').set(auth(user)).expect(403);

    expect(res.body.code).toBe('module_not_enabled');
  });
});
