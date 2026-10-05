import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PAYMENTS_GATEWAY, PaymentProviderUnavailableError, type InitiatePaymentInput, type InitiatedPayment } from '../../src/common/payments/payments-gateway';
import { PlatformDb } from '../../src/infrastructure/prisma/platform-db.service';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { createPatientRow } from '../appointments/appointment-fixtures';
import { FakePaymentsGateway } from '../helpers/fake-payments-gateway';
import { createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import {
  BILLING,
  auditActions,
  bearer,
  createBillingTenant,
  createRegisterRow,
  getInvoice,
  http,
  issuedInvoice,
  openSessionOk,
  payCash,
  payMobile,
  seedCatalog,
  type Catalog,
} from './billing-fixtures';

const UNKNOWN = randomUUID();

describe('paiements en ligne : abandon, succès tardif, surpaiement (R4)', () => {
  let app: INestApplication;
  let tenant: TenantFixture;
  let foreign: TenantFixture;
  let catalog: Catalog;
  let patientId: string;
  let receptionist: UserFixture;
  let cashier: UserFixture;
  let accountant: UserFixture;
  let foreignCashier: UserFixture;
  let sessionId: string;

  beforeAll(async () => {
    app = await createTestApp();
    [tenant, foreign] = await Promise.all([createBillingTenant(app, 'ab-a'), createBillingTenant(app, 'ab-b')]);
    catalog = await seedCatalog(app, tenant);
    patientId = await createPatientRow(app, tenant);
    receptionist = await createUserWithRole(app, tenant, 'receptionist');
    cashier = await createUserWithRole(app, tenant, 'cashier');
    accountant = await createUserWithRole(app, tenant, 'accountant');
    foreignCashier = await createUserWithRole(app, foreign, 'cashier');
    sessionId = (await openSessionOk(app, cashier, await createRegisterRow(app, tenant))).id;
  });

  afterAll(async () => {
    await app?.close();
  });

  const newInvoice = () => issuedInvoice(app, receptionist, tenant, patientId, catalog); // 8500.00

  async function initiate(invoiceId: string, amount = '8500.00') {
    const res = await payMobile(app, cashier, invoiceId, amount).expect(201);
    const paymentId = res.body.data.payment.id as string;
    const row = await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.patientPayment.findFirstOrThrow({ where: { id: paymentId } }));
    return { paymentId, attemptId: row.attemptId as string };
  }

  const abandon = (user: UserFixture, paymentId: string) => http(app).post(`${BILLING}/payments/${paymentId}/abandon`).set(bearer(user));
  const attempt = (attemptId: string) => app.get(PlatformDb).run((tx) => tx.paymentAttempt.findUniqueOrThrow({ where: { id: attemptId } }));
  const setRemote = async (attemptId: string, status: 'succeeded' | 'failed') => {
    const row = await attempt(attemptId);
    await app.get(PlatformDb).run((tx) => tx.sandboxTransaction.update({ where: { providerReference: row.providerReference as string }, data: { status } }));
  };

  describe('abandon', () => {
    it('annule le paiement sans succès chez le fournisseur, libère le montant et audite', async () => {
      const invoice = await newInvoice();
      const { paymentId, attemptId } = await initiate(invoice.id);

      const res = await abandon(cashier, paymentId).expect(200);

      expect(res.body.data).toEqual({ status: 'cancelled' });
      const detail = await getInvoice(app, cashier, invoice.id);
      expect(detail.payments[0]).toMatchObject({ id: paymentId, status: 'cancelled', failureReason: 'abandoned' });
      expect(detail).toMatchObject({ status: 'issued', amountPaid: '0.00', balance: '8500.00' });
      expect((await attempt(attemptId)).status).toBe('cancelled');
      const [entry] = await auditActions(app, tenant, 'payment.abandoned', paymentId);
      expect(entry?.changes).toMatchObject({ invoiceId: invoice.id, method: 'mobile_money', amount: '8500.00' });
      await payMobile(app, cashier, invoice.id, '8500.00').expect(201);
    });

    it('enregistre le paiement quand le fournisseur confirme un succès (pas d’annulation)', async () => {
      const invoice = await newInvoice();
      const { paymentId, attemptId } = await initiate(invoice.id);
      await setRemote(attemptId, 'succeeded');

      const res = await abandon(cashier, paymentId).expect(200);

      expect(res.body.data).toEqual({ status: 'succeeded' });
      expect(await getInvoice(app, cashier, invoice.id)).toMatchObject({ status: 'paid', amountPaid: '8500.00' });
    });

    it('est idempotent et ne touche pas un paiement déjà réglé', async () => {
      const invoice = await newInvoice();
      const { paymentId } = await initiate(invoice.id);

      await abandon(cashier, paymentId).expect(200);
      const again = await abandon(cashier, paymentId).expect(200);

      expect(again.body.data).toEqual({ status: 'cancelled' });
    });

    it('404 pour un paiement inconnu ou d’un autre établissement, 403 sans cashier:payment:create', async () => {
      const invoice = await newInvoice();
      const { paymentId } = await initiate(invoice.id);

      await abandon(cashier, UNKNOWN).expect(404);
      await abandon(foreignCashier, paymentId).expect(404);
      await abandon(accountant, paymentId).expect(403);
    });
  });

  describe('succès tardif', () => {
    it('enregistre le paiement abandonné quand le fournisseur confirme ensuite le succès', async () => {
      const invoice = await newInvoice();
      const { paymentId, attemptId } = await initiate(invoice.id);
      await abandon(cashier, paymentId).expect(200);
      await setRemote(attemptId, 'succeeded');

      await http(app).post(`${BILLING}/payments/${paymentId}/refresh`).set(bearer(cashier)).expect(200);

      const detail = await getInvoice(app, cashier, invoice.id);
      expect(detail.payments[0]).toMatchObject({ id: paymentId, status: 'succeeded' });
      expect(detail).toMatchObject({ status: 'paid', amountPaid: '8500.00' });
      expect((await attempt(attemptId)).status).toBe('succeeded');
    });

    it('marque anomaly « overpaid » (et l’audite) quand la facture a été soldée entre-temps', async () => {
      const invoice = await newInvoice();
      const { paymentId, attemptId } = await initiate(invoice.id);
      await abandon(cashier, paymentId).expect(200);
      await payCash(app, cashier, invoice.id, '8500.00', sessionId).expect(201);
      await setRemote(attemptId, 'succeeded');

      await http(app).post(`${BILLING}/payments/${paymentId}/refresh`).set(bearer(cashier)).expect(200);

      const detail = await getInvoice(app, cashier, invoice.id);
      expect(detail.payments.find((p) => p.id === paymentId)).toMatchObject({ status: 'succeeded', anomaly: 'overpaid' });
      expect(detail.balance).toBe('0.00');
      const [entry] = await auditActions(app, tenant, 'payment.succeeded', paymentId);
      expect(entry?.changes).toMatchObject({ anomaly: 'overpaid' });
    });

    it('enregistre le paiement d’une facture annulée entre-temps sans modifier la facture (anomalie)', async () => {
      const invoice = await newInvoice();
      const { paymentId, attemptId } = await initiate(invoice.id);
      await abandon(cashier, paymentId).expect(200);
      await http(app).post(`${BILLING}/invoices/${invoice.id}/void`).set(bearer(accountant)).send({ reasonCode: 'duplicate' }).expect(200);
      await setRemote(attemptId, 'succeeded');

      await http(app).post(`${BILLING}/payments/${paymentId}/refresh`).set(bearer(cashier)).expect(200);

      const detail = await getInvoice(app, cashier, invoice.id);
      expect(detail).toMatchObject({ status: 'void', amountPaid: '0.00' });
      expect(detail.payments.find((p) => p.id === paymentId)).toMatchObject({ status: 'succeeded', anomaly: 'overpaid' });
    });
  });

  describe('refresh : audit et intervalle minimal', () => {
    it('audite la reprise manuelle et refuse deux reprises rapprochées (429)', async () => {
      const invoice = await newInvoice();
      const { paymentId } = await initiate(invoice.id);

      await http(app).post(`${BILLING}/payments/${paymentId}/refresh`).set(bearer(cashier)).expect(200);
      const second = await http(app).post(`${BILLING}/payments/${paymentId}/refresh`).set(bearer(cashier));

      expect(second.status).toBe(429);
      const entries = await auditActions(app, tenant, 'payment.refreshed', paymentId);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.changes).toMatchObject({ status: 'pending' });
    });

    it('audite le passage en échec d’un paiement refusé par le fournisseur', async () => {
      const invoice = await newInvoice();
      const { paymentId, attemptId } = await initiate(invoice.id);
      await setRemote(attemptId, 'failed');

      await http(app).post(`${BILLING}/payments/${paymentId}/refresh`).set(bearer(cashier)).expect(200);

      const [entry] = await auditActions(app, tenant, 'payment.failed', paymentId);
      expect(entry).toMatchObject({ actorType: 'system' });
      expect(entry?.changes).toMatchObject({ reason: 'declined_by_provider' });
    });
  });
});

/** Passerelle dont l'initiation échoue comme le ferait le module payments (échec technique ou refus explicite). */
class UnavailableGateway extends FakePaymentsGateway {
  failure: PaymentProviderUnavailableError | null = null;

  override initiate(input: InitiatePaymentInput): Promise<InitiatedPayment> {
    return this.failure ? Promise.reject(this.failure) : super.initiate(input);
  }
}

describe('paiements en ligne : échec à l’initiation (R7 et docs/09 §R)', () => {
  const gateway = new UnavailableGateway();
  let app: INestApplication;
  let tenant: TenantFixture;
  let catalog: Catalog;
  let patientId: string;
  let receptionist: UserFixture;
  let cashier: UserFixture;

  beforeAll(async () => {
    app = await createTestApp({}, { providerOverrides: [{ token: PAYMENTS_GATEWAY, useValue: gateway }] });
    tenant = await createBillingTenant(app, 'init-f');
    catalog = await seedCatalog(app, tenant);
    patientId = await createPatientRow(app, tenant);
    receptionist = await createUserWithRole(app, tenant, 'receptionist');
    cashier = await createUserWithRole(app, tenant, 'cashier');
  });

  afterAll(async () => {
    await app?.close();
  });

  it('échec technique : 502 payment_provider_unavailable, le paiement reste « pending » rattaché à sa tentative', async () => {
    const invoice = await issuedInvoice(app, receptionist, tenant, patientId, catalog);
    const attemptId = randomUUID();
    gateway.failure = new PaymentProviderUnavailableError(attemptId, true);

    const res = await payMobile(app, cashier, invoice.id, '1000.00').expect(502);
    gateway.failure = null;

    expect(res.body.code).toBe('payment_provider_unavailable');
    const detail = await getInvoice(app, cashier, invoice.id);
    expect(detail.payments).toHaveLength(1);
    expect(detail.payments[0]).toMatchObject({ status: 'pending' });
    const row = await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.patientPayment.findFirstOrThrow({ where: { invoiceId: invoice.id } }));
    expect(row.attemptId).toBe(attemptId);
    const retry = await payMobile(app, cashier, invoice.id, '1000.00').expect(409);
    expect(retry.body.code).toBe('payment_already_pending');
  });

  it('refus explicite : le paiement passe à « failed » (audité) et une nouvelle demande reste possible', async () => {
    const invoice = await issuedInvoice(app, receptionist, tenant, patientId, catalog);
    gateway.failure = new PaymentProviderUnavailableError(randomUUID(), false);

    await payMobile(app, cashier, invoice.id, '1000.00').expect(502);
    gateway.failure = null;

    const detail = await getInvoice(app, cashier, invoice.id);
    expect(detail.payments[0]).toMatchObject({ status: 'failed', failureReason: 'provider_unavailable' });
    const [entry] = await auditActions(app, tenant, 'payment.failed', detail.payments[0]!.id);
    expect(entry?.changes).toMatchObject({ reason: 'provider_unavailable' });
    await payMobile(app, cashier, invoice.id, '1000.00').expect(201);
  });
});
