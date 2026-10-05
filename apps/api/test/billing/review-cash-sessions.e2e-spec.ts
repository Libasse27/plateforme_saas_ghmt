import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPatientRow } from '../appointments/appointment-fixtures';
import { createUserWithPermissions, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import {
  CASHIER,
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

describe('caisse : clôture contradictoire et note d’écart (R8)', () => {
  let app: INestApplication;
  let tenant: TenantFixture;
  let catalog: Catalog;
  let patientId: string;
  let receptionist: UserFixture;
  let cashier: UserFixture;
  let accountant: UserFixture;
  let director: UserFixture;
  let openerWithValidate: UserFixture;

  beforeAll(async () => {
    app = await createTestApp();
    tenant = await createBillingTenant(app, 'cais');
    catalog = await seedCatalog(app, tenant);
    patientId = await createPatientRow(app, tenant);
    receptionist = await createUserWithRole(app, tenant, 'receptionist');
    cashier = await createUserWithRole(app, tenant, 'cashier');
    accountant = await createUserWithRole(app, tenant, 'accountant');
    director = await createUserWithPermissions(app, tenant, ['cashier:cash_session:read', 'cashier:cash_session:validate']);
    openerWithValidate = await createUserWithPermissions(app, tenant, ['cashier:cash_session:read', 'cashier:cash_session:create', 'cashier:cash_session:validate']);
  });

  afterAll(async () => {
    await app?.close();
  });

  const newSession = async (opener: UserFixture = cashier, openingFloat = '10000.00') => openSessionOk(app, opener, await createRegisterRow(app, tenant), openingFloat);
  const close = (user: UserFixture, id: string, body: Record<string, unknown>) => http(app).post(`${CASHIER}/sessions/${id}/close`).set(bearer(user)).send(body);
  const forceClose = (user: UserFixture, id: string, body: Record<string, unknown>) => http(app).post(`${CASHIER}/sessions/${id}/force-close`).set(bearer(user)).send(body);

  describe('clôture normale', () => {
    it('exige une note quand l’écart est non nul (422 closing_note_required)', async () => {
      const session = await newSession();

      const res = await close(cashier, session.id, { countedAmount: '9500.00' }).expect(422);

      expect(res.body.code).toBe('closing_note_required');
    });

    it('accepte l’écart avec une note, et un écart nul sans note', async () => {
      const withVariance = await newSession();
      const exact = await newSession();

      const noted = await close(cashier, withVariance.id, { countedAmount: '9500.00', note: 'Billet de 500 rendu en trop' }).expect(200);
      const clean = await close(cashier, exact.id, { countedAmount: '10000.00' }).expect(200);

      expect(noted.body.data).toMatchObject({ status: 'closed', variance: '-500.00', forceClosed: false });
      expect(clean.body.data.variance).toBe('0.00');
    });

    it('refuse un montant compté à décimales en XOF (422 amount_scale)', async () => {
      const session = await newSession();

      const res = await close(cashier, session.id, { countedAmount: '10000.50', note: 'x' }).expect(422);

      expect(res.body.code).toBe('amount_scale');
    });
  });

  describe('force-close (clôture contradictoire)', () => {
    it('permet à un tiers habilité de clôturer la session d’un caissier absent, avec audit', async () => {
      const session = await newSession();
      const invoice = await issuedInvoice(app, receptionist, tenant, patientId, catalog);
      await payCash(app, cashier, invoice.id, '4000.00', session.id).expect(201);

      const res = await forceClose(accountant, session.id, { countedAmount: '14000', reason: 'Caissier absent, comptage contradictoire' }).expect(200);
      const [entry] = await auditActions(app, tenant, 'cash_session.force_closed', session.id);

      expect(res.body.data).toMatchObject({ status: 'closed', forceClosed: true, closedBy: accountant.userId, expectedTotal: '14000.00', variance: '0.00' });
      expect(entry?.changes).toMatchObject({ expectedTotal: '14000.00', countedAmount: '14000.00', variance: '0.00' });
    });

    it('enregistre l’écart et la raison quand le comptage diffère', async () => {
      const session = await newSession();

      const res = await forceClose(accountant, session.id, { countedAmount: '9000', reason: 'Écart constaté à la reprise' }).expect(200);

      expect(res.body.data).toMatchObject({ variance: '-1000.00', forceClosed: true });
    });

    it('est refusé à l’ouvreur, même habilité (403)', async () => {
      const session = await newSession(openerWithValidate);

      const res = await forceClose(openerWithValidate, session.id, { countedAmount: '10000', reason: 'Je clôture seul' }).expect(403);

      expect(res.body.code).toBe('cash_session_force_close_forbidden');
    });

    it('est refusé sans la permission de validation (403), exige une raison (422) et une session ouverte (409)', async () => {
      const session = await newSession();

      await forceClose(cashier, session.id, { countedAmount: '10000', reason: 'Sans droit' }).expect(403);
      await forceClose(accountant, session.id, { countedAmount: '10000' }).expect(422);
      await forceClose(accountant, session.id, { countedAmount: '10000', reason: 'Clôture légitime' }).expect(200);
      await forceClose(accountant, session.id, { countedAmount: '10000', reason: 'Seconde clôture' }).expect(409);
    });

    it('rend la session invisible à un utilisateur d’un autre établissement (404)', async () => {
      const other = await createBillingTenant(app, 'cais-b');
      const foreign = await createUserWithRole(app, other, 'accountant');
      const session = await newSession();

      await forceClose(foreign, session.id, { countedAmount: '10000', reason: 'Autre établissement' }).expect(404);
    });

    it('applique la séparation des tâches : celui qui a forcé la clôture ne peut pas valider', async () => {
      const session = await newSession();
      await forceClose(accountant, session.id, { countedAmount: '10000', reason: 'Clôture contradictoire' }).expect(200);

      const byCloser = await http(app).post(`${CASHIER}/sessions/${session.id}/validate`).set(bearer(accountant)).send({}).expect(403);
      await http(app).post(`${CASHIER}/sessions/${session.id}/validate`).set(bearer(director)).send({}).expect(200);

      expect(byCloser.body.code).toBe('separation_of_duties');
      void openSession;
    });
  });
});
