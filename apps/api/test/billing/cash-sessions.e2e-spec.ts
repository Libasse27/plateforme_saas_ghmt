import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { createSite, createPatientRow } from '../appointments/appointment-fixtures';
import { createUserWithPermissions, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import {
  BILLING,
  CASHIER,
  UNKNOWN_ID,
  auditActions,
  bearer,
  createBillingTenant,
  createRegisterRow,
  http,
  issuedInvoice,
  openSession,
  openSessionOk,
  payCash,
  seedCatalog,
  type Catalog,
} from './billing-fixtures';

describe('caisse : caisses et sessions (HTTP)', () => {
  let app: INestApplication;
  let a: TenantFixture;
  let b: TenantFixture;
  let catalog: Catalog;
  let patientId: string;
  let cashier: UserFixture;
  let secondCashier: UserFixture;
  let accountant: UserFixture;
  let receptionist: UserFixture;
  let supervisor: UserFixture;
  let foreignCashier: UserFixture;

  beforeAll(async () => {
    app = await createTestApp();
    [a, b] = await Promise.all([createBillingTenant(app, 'caisse-a'), createBillingTenant(app, 'caisse-b')]);
    catalog = await seedCatalog(app, a);
    patientId = await createPatientRow(app, a);
    cashier = await createUserWithRole(app, a, 'cashier');
    secondCashier = await createUserWithRole(app, a, 'cashier');
    accountant = await createUserWithRole(app, a, 'accountant');
    receptionist = await createUserWithRole(app, a, 'receptionist');
    // Superviseur pouvant à la fois ouvrir et valider : sert à prouver la séparation des tâches.
    supervisor = await createUserWithPermissions(app, a, ['cashier:cash_session:read', 'cashier:cash_session:create', 'cashier:cash_session:validate', 'cashier:payment:create']);
    foreignCashier = await createUserWithRole(app, b, 'cashier');
  });

  afterAll(async () => {
    await app?.close();
  });

  const closeSession = (user: UserFixture, id: string, countedAmount: string, extra: Record<string, unknown> = {}) =>
    http(app).post(`${CASHIER}/sessions/${id}/close`).set(bearer(user)).send({ countedAmount, ...extra });
  const validateSession = (user: UserFixture, id: string, body: Record<string, unknown> = {}) =>
    http(app).post(`${CASHIER}/sessions/${id}/validate`).set(bearer(user)).send(body);

  describe('caisses', () => {
    it('crée une caisse pour un site (superviseur) et la liste ; code unique par site (409)', async () => {
      const body = { siteId: a.mainSiteId, code: 'CAISSE-1', name: 'Caisse principale' };

      const res = await http(app).post(`${CASHIER}/registers`).set(bearer(accountant)).send(body).expect(201);
      const list = await http(app).get(`${CASHIER}/registers`).set(bearer(cashier)).expect(200);
      const dup = await http(app).post(`${CASHIER}/registers`).set(bearer(accountant)).send(body).expect(409);

      expect(res.body.data).toMatchObject({ code: 'CAISSE-1', siteId: a.mainSiteId, currency: 'XOF', isActive: true });
      expect(list.body.data.map((r: { id: string }) => r.id)).toContain(res.body.data.id);
      expect(dup.body.code).toBe('cash_register_code_taken');
      expect((await auditActions(app, a, 'cash_register.created', res.body.data.id)).length).toBe(1);
    });

    it('refuse (422) un site inconnu ou étranger, un corps invalide ; (403) sans permission', async () => {
      await http(app).post(`${CASHIER}/registers`).set(bearer(accountant)).send({ siteId: b.mainSiteId, code: 'X', name: 'Caisse' }).expect(422);
      await http(app).post(`${CASHIER}/registers`).set(bearer(accountant)).send({ siteId: a.mainSiteId, code: 'x y', name: '' }).expect(422);
      await http(app).post(`${CASHIER}/registers`).set(bearer(cashier)).send({ siteId: a.mainSiteId, code: 'X2', name: 'Caisse' }).expect(403);
      await http(app).get(`${CASHIER}/registers`).set(bearer(receptionist)).expect(403);
    });

    it('cloisonne les caisses entre établissements', async () => {
      await createRegisterRow(app, b);

      const list = await http(app).get(`${CASHIER}/registers`).set(bearer(cashier)).expect(200);

      expect(list.body.data.every((r: { siteId: string }) => r.siteId !== b.mainSiteId)).toBe(true);
    });
  });

  describe('ouverture', () => {
    it('ouvre une session avec un fond de caisse ; attendu = fond ; audit', async () => {
      const register = await createRegisterRow(app, a);

      const session = await openSessionOk(app, cashier, register, '15000.00');

      expect(session).toMatchObject({ status: 'open', openedBy: cashier.userId, openingFloat: '15000.00', expectedTotal: '15000.00', cashRegisterId: register, currency: 'XOF' });
      const [entry] = await auditActions(app, a, 'cash_session.opened', session.id);
      expect(entry?.changes).toMatchObject({ cashRegisterId: register, openingFloat: '15000.00' });
    });

    it('refuse une seconde session ouverte sur la même caisse (409), même sous concurrence', async () => {
      const register = await createRegisterRow(app, a);

      const results = await Promise.all([openSession(app, cashier, register), openSession(app, secondCashier, register), openSession(app, supervisor, register)]);

      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
      expect(results.find((r) => r.status === 409)?.body.code).toBe('cash_session_already_open');
    });

    it('autorise une nouvelle session une fois la précédente clôturée', async () => {
      const register = await createRegisterRow(app, a);
      const first = await openSessionOk(app, cashier, register);
      await closeSession(cashier, first.id, '10000.00').expect(200);

      await openSession(app, secondCashier, register).expect(201);
    });

    it('valide le corps (422), 404 pour une caisse inconnue/étrangère, 403 sans permission', async () => {
      const register = await createRegisterRow(app, a);

      await openSession(app, cashier, register, '-5').expect(422);
      await http(app).post(`${CASHIER}/sessions`).set(bearer(cashier)).send({ cashRegisterId: register, openingFloat: 100 }).expect(422);
      await openSession(app, cashier, UNKNOWN_ID).expect(404);
      await openSession(app, foreignCashier, register).expect(404);
      await openSession(app, accountant, register).expect(403);
    });

    it('refuse (404) l’ouverture sur une caisse hors du périmètre de l’utilisateur', async () => {
      const otherSite = await createSite(app, a, 'SITE-CAISSE-X');
      const register = await createRegisterRow(app, a, otherSite);
      const scoped = await createUserWithRole(app, a, 'cashier', { scopeType: 'site', scopeId: a.mainSiteId });

      await openSession(app, scoped, register).expect(404);
    });
  });

  describe('clôture', () => {
    it('calcule attendu (fond + espèces) et écart (compté − attendu), fige les valeurs et audite', async () => {
      const session = await openSessionOk(app, cashier, await createRegisterRow(app, a), '10000.00');
      const invoice = await issuedInvoice(app, receptionistOf(), a, patientId, catalog); // 8500.50
      await payCash(app, cashier, invoice.id, '8500.50', session.id).expect(201);
      // Un paiement « autre mode » ne passe pas par la caisse physique.
      const other = await issuedInvoice(app, receptionistOf(), a, patientId, catalog);
      await http(app).post(`${BILLING}/invoices/${other.id}/payments`).set(bearer(cashier)).send({ method: 'other', amount: '100.00', reference: 'CHQ-1' }).expect(201);

      const live = await http(app).get(`${CASHIER}/sessions/${session.id}`).set(bearer(cashier)).expect(200);
      const closed = await closeSession(cashier, session.id, '18000.00', { note: 'Billet de 500 manquant' }).expect(200);

      expect(live.body.data.expectedTotal).toBe('18500.50');
      expect(closed.body.data).toMatchObject({ status: 'closed', expectedTotal: '18500.50', closingCounted: '18000.00', variance: '-500.50', closedBy: cashier.userId });
      expect(closed.body.data.closedAt).not.toBeNull();
      const [entry] = await auditActions(app, a, 'cash_session.closed', session.id);
      expect(entry?.changes).toMatchObject({ expectedTotal: '18500.50', countedAmount: '18000.00', variance: '-500.50' });
    });

    it('seul l’ouvreur clôture (403), une seule fois (409), 404 si inconnue ou étrangère', async () => {
      const session = await openSessionOk(app, cashier, await createRegisterRow(app, a));

      const notOwner = await closeSession(secondCashier, session.id, '10000.00').expect(403);
      await closeSession(cashier, session.id, '10000.00').expect(200);
      const twice = await closeSession(cashier, session.id, '10000.00').expect(409);

      expect(notOwner.body.code).toBe('cash_session_not_owner');
      expect(twice.body.code).toBe('cash_session_not_open');
      await closeSession(cashier, UNKNOWN_ID, '1.00').expect(404);
      await closeSession(foreignCashier, session.id, '1.00').expect(404);
      await closeSession(cashier, session.id, 'abc').expect(422);
    });

    it('un encaissement est impossible dans une session clôturée', async () => {
      const session = await openSessionOk(app, cashier, await createRegisterRow(app, a));
      await closeSession(cashier, session.id, '10000.00').expect(200);
      const invoice = await issuedInvoice(app, receptionistOf(), a, patientId, catalog);

      await payCash(app, cashier, invoice.id, '100.00', session.id).expect(409);
    });
  });

  describe('validation et séparation des tâches', () => {
    it('un autre utilisateur (comptable) valide la clôture ; la session devient immuable', async () => {
      const session = await openSessionOk(app, cashier, await createRegisterRow(app, a));
      await closeSession(cashier, session.id, '10000.00').expect(200);

      const res = await validateSession(accountant, session.id, { note: 'Contrôlé' }).expect(200);

      expect(res.body.data).toMatchObject({ status: 'validated', validatedBy: accountant.userId });
      expect(res.body.data.validatedAt).not.toBeNull();
      expect((await auditActions(app, a, 'cash_session.validated', session.id)).length).toBe(1);
      await validateSession(accountant, session.id).expect(409);
      await expect(app.get(TenantDb).runAs(a.tenantId, (tx) => tx.$executeRaw`UPDATE tenant.cash_sessions SET closing_counted = 1 WHERE id = ${session.id}::uuid`)).rejects.toThrow();
    });

    it('l’ouvreur ne valide pas sa propre clôture (403 separation_of_duties), même avec la permission', async () => {
      const session = await openSessionOk(app, supervisor, await createRegisterRow(app, a));
      await closeSession(supervisor, session.id, '10000.00').expect(200);

      const res = await validateSession(supervisor, session.id).expect(403);

      expect(res.body.code).toBe('separation_of_duties');
      expect((await http(app).get(`${CASHIER}/sessions/${session.id}`).set(bearer(supervisor)).expect(200)).body.data.status).toBe('closed');
    });

    it('refuse de valider une session encore ouverte (409), sans permission (403), inconnue/étrangère (404)', async () => {
      const session = await openSessionOk(app, cashier, await createRegisterRow(app, a));

      const open = await validateSession(accountant, session.id).expect(409);
      await validateSession(cashier, session.id).expect(403);
      await validateSession(accountant, UNKNOWN_ID).expect(404);
      await validateSession(await createUserWithRole(app, b, 'accountant'), session.id).expect(404);

      expect(open.body.code).toBe('cash_session_not_closed');
    });

    it('la base refuse une validation par l’ouvreur ou par celui qui a clôturé, hors API', async () => {
      const session = await openSessionOk(app, cashier, await createRegisterRow(app, a));
      await closeSession(cashier, session.id, '10000.00').expect(200);
      const tenantDb = app.get(TenantDb);

      await expect(
        tenantDb.runAs(a.tenantId, (tx) => tx.$executeRaw`UPDATE tenant.cash_sessions SET status = 'validated', validated_by = ${cashier.userId}::uuid, validated_at = now() WHERE id = ${session.id}::uuid`),
      ).rejects.toThrow();
    });
  });

  describe('lecture', () => {
    it('liste les sessions avec filtres statut et « mine », pagination par curseur', async () => {
      const mineOpen = await openSessionOk(app, secondCashier, await createRegisterRow(app, a));
      const closed = await openSessionOk(app, secondCashier, await createRegisterRow(app, a));
      await closeSession(secondCashier, closed.id, '10000.00').expect(200);

      const mine = await http(app).get(`${CASHIER}/sessions?mine=true&limit=100`).set(bearer(secondCashier)).expect(200);
      const open = await http(app).get(`${CASHIER}/sessions?status=open&mine=true`).set(bearer(secondCashier)).expect(200);
      const page = await http(app).get(`${CASHIER}/sessions?mine=true&limit=1`).set(bearer(secondCashier)).expect(200);

      expect(mine.body.data.every((s: { openedBy: string }) => s.openedBy === secondCashier.userId)).toBe(true);
      expect(open.body.data.map((s: { id: string }) => s.id)).toContain(mineOpen.id);
      expect(open.body.data.every((s: { status: string }) => s.status === 'open')).toBe(true);
      expect(page.body.meta.pagination.hasMore).toBe(true);
      await http(app).get(`${CASHIER}/sessions?cursor=!!`).set(bearer(cashier)).expect(422);
    });

    it('404 pour une session d’un autre établissement', async () => {
      const theirs = await openSessionOk(app, foreignCashier, await createRegisterRow(app, b));

      await http(app).get(`${CASHIER}/sessions/${theirs.id}`).set(bearer(cashier)).expect(404);
      const list = await http(app).get(`${CASHIER}/sessions?limit=100`).set(bearer(cashier)).expect(200);
      expect(list.body.data.map((s: { id: string }) => s.id)).not.toContain(theirs.id);
    });
  });

  function receptionistOf(): UserFixture {
    return receptionist;
  }
});
