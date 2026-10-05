import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { createPatientRow } from '../appointments/appointment-fixtures';
import { createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import {
  BILLING,
  CASHIER,
  UNKNOWN_ID,
  auditActions,
  bearer,
  createBillingTenant,
  createRegisterRow,
  getInvoice,
  http,
  issuedInvoice,
  openSessionOk,
  payCash,
  seedCatalog,
  type Catalog,
} from './billing-fixtures';

describe('encaissements en espèces et autres modes (HTTP)', () => {
  let app: INestApplication;
  let a: TenantFixture;
  let b: TenantFixture;
  let catalog: Catalog;
  let patientId: string;
  let receptionist: UserFixture;
  let cashier: UserFixture;
  let otherCashier: UserFixture;
  let accountant: UserFixture;
  let foreignCashier: UserFixture;
  let sessionId: string;

  beforeAll(async () => {
    app = await createTestApp();
    [a, b] = await Promise.all([createBillingTenant(app, 'esp-a'), createBillingTenant(app, 'esp-b')]);
    catalog = await seedCatalog(app, a);
    patientId = await createPatientRow(app, a);
    receptionist = await createUserWithRole(app, a, 'receptionist');
    cashier = await createUserWithRole(app, a, 'cashier');
    otherCashier = await createUserWithRole(app, a, 'cashier');
    accountant = await createUserWithRole(app, a, 'accountant');
    foreignCashier = await createUserWithRole(app, b, 'cashier');
    sessionId = (await openSessionOk(app, cashier, await createRegisterRow(app, a))).id;
  });

  afterAll(async () => {
    await app?.close();
  });

  const newInvoice = () => issuedInvoice(app, receptionist, a, patientId, catalog); // 8500.00

  describe('espèces', () => {
    it('enregistre un paiement partiel puis le solde, et recalcule le statut de la facture', async () => {
      const invoice = await newInvoice();

      const partial = await payCash(app, cashier, invoice.id, '3000.00', sessionId).expect(201);
      const afterPartial = await getInvoice(app, cashier, invoice.id);
      const rest = await payCash(app, cashier, invoice.id, '5500.00', sessionId).expect(201);
      const afterFull = await getInvoice(app, cashier, invoice.id);

      expect(partial.body.data).toMatchObject({ method: 'cash', amount: '3000.00', status: 'succeeded', cashSessionId: sessionId, currency: 'XOF' });
      expect(afterPartial).toMatchObject({ status: 'partially_paid', amountPaid: '3000.00', balance: '5500.00' });
      expect(rest.body.data.status).toBe('succeeded');
      expect(afterFull).toMatchObject({ status: 'paid', amountPaid: '8500.00', balance: '0.00' });
      expect(afterFull.payments).toHaveLength(2);
    });

    it('refuse un montant supérieur au reste dû (422) et un paiement sur une facture soldée (409)', async () => {
      const invoice = await newInvoice();

      const tooMuch = await payCash(app, cashier, invoice.id, '8501.00', sessionId).expect(422);
      await payCash(app, cashier, invoice.id, '8500.00', sessionId).expect(201);
      const settled = await payCash(app, cashier, invoice.id, '0.01', sessionId).expect(409);

      expect(tooMuch.body.code).toBe('amount_exceeds_balance');
      expect(tooMuch.body.balance ?? tooMuch.body.details?.balance).toBe('8500.00');
      expect(settled.body.code).toBe('invoice_not_payable');
    });

    it('somme exactement les montants (aucune dérive de flottant)', async () => {
      const invoice = await newInvoice();
      for (const amount of ['100', '200', '300']) await payCash(app, cashier, invoice.id, amount, sessionId).expect(201);

      expect((await getInvoice(app, cashier, invoice.id)).amountPaid).toBe('600.00');
    });

    it('refuse sur un brouillon et sur une facture annulée (409)', async () => {
      const draftRes = await http(app)
        .post(`${BILLING}/invoices`)
        .set(bearer(receptionist))
        .send({ patientId, siteId: a.mainSiteId, lines: [{ priceListItemId: catalog.drug.id }] })
        .expect(201);
      const voided = await newInvoice();
      await http(app).post(`${BILLING}/invoices/${voided.id}/void`).set(bearer(accountant)).send({ reasonCode: 'other', comment: 'Annulation de test' }).expect(200);

      await payCash(app, cashier, draftRes.body.data.id, '10.00', sessionId).expect(409);
      await payCash(app, cashier, voided.id, '10.00', sessionId).expect(409);
    });

    it('exige une session de caisse (422), ouverte (409) et ouverte par l’encaisseur (403)', async () => {
      const invoice = await newInvoice();
      const closedSession = await openSessionOk(app, otherCashier, await createRegisterRow(app, a));
      await http(app).post(`${CASHIER}/sessions/${closedSession.id}/close`).set(bearer(otherCashier)).send({ countedAmount: '10000.00' }).expect(200);

      await http(app).post(`${BILLING}/invoices/${invoice.id}/payments`).set(bearer(cashier)).send({ method: 'cash', amount: '10.00' }).expect(422);
      const closed = await payCash(app, otherCashier, invoice.id, '10.00', closedSession.id).expect(409);
      const notMine = await payCash(app, otherCashier, invoice.id, '10.00', sessionId).expect(403);
      await payCash(app, cashier, invoice.id, '10.00', UNKNOWN_ID).expect(422);

      expect(closed.body.code).toBe('cash_session_not_open');
      expect(notMine.body.code).toBe('cash_session_not_owned');
      expect((await getInvoice(app, cashier, invoice.id)).payments).toHaveLength(0);
    });

    it('refuse une session d’un autre établissement (422) et une facture d’un autre établissement (404)', async () => {
      const foreignSession = await openSessionOk(app, foreignCashier, await createRegisterRow(app, b));
      const invoice = await newInvoice();

      await payCash(app, cashier, invoice.id, '10.00', foreignSession.id).expect(422);
      await payCash(app, foreignCashier, invoice.id, '10.00', foreignSession.id).expect(404);
      await payCash(app, cashier, UNKNOWN_ID, '10.00', sessionId).expect(404);
    });

    it('valide le corps (422) : montant nul, flottant, mode inconnu', async () => {
      const invoice = await newInvoice();
      const post = (body: Record<string, unknown>) => http(app).post(`${BILLING}/invoices/${invoice.id}/payments`).set(bearer(cashier)).send(body);

      await post({ method: 'cash', amount: '0.00', cashSessionId: sessionId }).expect(422);
      await post({ method: 'cash', amount: 100, cashSessionId: sessionId }).expect(422);
      await post({ method: 'bitcoin', amount: '100.00' }).expect(422);
      await post({ method: 'cash', amount: '-5.00', cashSessionId: sessionId }).expect(422);
    });

    it('refuse sans cashier:payment:create (403) : réceptionniste et comptable ne encaissent pas', async () => {
      const invoice = await newInvoice();

      await payCash(app, receptionist, invoice.id, '10.00', sessionId).expect(403);
      await payCash(app, accountant, invoice.id, '10.00', sessionId).expect(403);
      await http(app).post(`${BILLING}/invoices/${invoice.id}/payments`).send({ method: 'cash', amount: '10.00', cashSessionId: sessionId }).expect(401);
    });

    it('audite l’encaissement (identifiants et montants uniquement)', async () => {
      const invoice = await newInvoice();
      const res = await payCash(app, cashier, invoice.id, '1200.00', sessionId).expect(201);

      const [entry] = await auditActions(app, a, 'payment.recorded', res.body.data.id);

      expect(entry).toMatchObject({ resourceType: 'payment', patientId, actorUserId: cashier.userId });
      expect(entry?.changes).toMatchObject({ invoiceId: invoice.id, method: 'cash', amount: '1200.00', invoiceStatus: 'partially_paid' });
    });

    it('interdit l’annulation d’une facture déjà encaissée (409 invoice_has_payments)', async () => {
      const invoice = await newInvoice();
      await payCash(app, cashier, invoice.id, '100.00', sessionId).expect(201);

      const res = await http(app).post(`${BILLING}/invoices/${invoice.id}/void`).set(bearer(accountant)).send({ reasonCode: 'other', comment: 'Annulation tardive' }).expect(409);

      expect(res.body.code).toBe('invoice_has_payments');
    });
  });

  describe('autre mode (chèque, virement)', () => {
    it('enregistre le paiement rattaché à la session de caisse avec sa référence (R9)', async () => {
      const invoice = await newInvoice();

      const res = await http(app)
        .post(`${BILLING}/invoices/${invoice.id}/payments`)
        .set(bearer(cashier))
        .send({ method: 'other', amount: '8500.00', cashSessionId: sessionId, reference: 'CHQ-0001' })
        .expect(201);

      expect(res.body.data).toMatchObject({ method: 'other', status: 'succeeded', reference: 'CHQ-0001', cashSessionId: sessionId });
      expect((await getInvoice(app, cashier, invoice.id)).status).toBe('paid');
    });
  });

  describe('périmètre de la caisse', () => {
    it('un caissier limité à un autre site ne peut pas encaisser une facture de ce site (404)', async () => {
      const invoice = await newInvoice();
      const scoped = await createUserWithRole(app, a, 'cashier', { scopeType: 'site', scopeId: UNKNOWN_ID });

      await payCash(app, scoped, invoice.id, '10.00', sessionId).expect(404);
    });
  });

  describe('garanties de la base de données', () => {
    it('un paiement enregistré est immuable et non supprimable, même hors API', async () => {
      const invoice = await newInvoice();
      const res = await payCash(app, cashier, invoice.id, '500.00', sessionId).expect(201);
      const tenantDb = app.get(TenantDb);

      await expect(tenantDb.runAs(a.tenantId, (tx) => tx.$executeRaw`UPDATE tenant.payments SET amount = 1 WHERE id = ${res.body.data.id}::uuid`)).rejects.toThrow();
      await expect(tenantDb.runAs(a.tenantId, (tx) => tx.$executeRaw`UPDATE tenant.payments SET status = 'failed' WHERE id = ${res.body.data.id}::uuid`)).rejects.toThrow();
      await expect(tenantDb.runAs(a.tenantId, (tx) => tx.$executeRaw`DELETE FROM tenant.payments WHERE id = ${res.body.data.id}::uuid`)).rejects.toThrow();
    });

    it('refuse en base un paiement en espèces sans session de caisse', async () => {
      const invoice = await newInvoice();
      const tenantDb = app.get(TenantDb);

      await expect(
        tenantDb.runAs(a.tenantId, (tx) =>
          tx.patientPayment.create({
            data: { tenantId: a.tenantId, invoiceId: invoice.id, patientId, method: 'cash', amount: '10.00', currency: 'XOF', status: 'succeeded' },
          }),
        ),
      ).rejects.toThrow();
    });
  });
});
