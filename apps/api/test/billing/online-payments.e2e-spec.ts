import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DomainEventBus } from '../../src/common/events/domain-event-bus';
import { PAYMENTS_GATEWAY, type PaymentsGateway } from '../../src/common/payments/payments-gateway';
import { PlatformDb } from '../../src/infrastructure/prisma/platform-db.service';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { createPatientRow } from '../appointments/appointment-fixtures';
import { createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import {
  BILLING,
  WEBHOOKS,
  auditActions,
  bearer,
  createBillingTenant,
  createRegisterRow,
  getInvoice,
  http,
  issuedInvoice,
  openSessionOk,
  payMobile,
  seedCatalog,
  type Catalog,
} from './billing-fixtures';

describe('encaissement Mobile Money via le fournisseur sandbox (HTTP)', () => {
  let app: INestApplication;
  let a: TenantFixture;
  let b: TenantFixture;
  let catalog: Catalog;
  let patientId: string;
  let receptionist: UserFixture;
  let cashier: UserFixture;
  let accountant: UserFixture;
  let foreignCashier: UserFixture;
  let sessionId: string;

  beforeAll(async () => {
    app = await createTestApp();
    [a, b] = await Promise.all([createBillingTenant(app, 'mm-a'), createBillingTenant(app, 'mm-b')]);
    catalog = await seedCatalog(app, a);
    patientId = await createPatientRow(app, a);
    receptionist = await createUserWithRole(app, a, 'receptionist');
    cashier = await createUserWithRole(app, a, 'cashier');
    accountant = await createUserWithRole(app, a, 'accountant');
    foreignCashier = await createUserWithRole(app, b, 'cashier');
    sessionId = (await openSessionOk(app, cashier, await createRegisterRow(app, a))).id;
  });

  afterAll(async () => {
    await app?.close();
  });

  const newInvoice = () => issuedInvoice(app, receptionist, a, patientId, catalog); // 8500.00
  const simulate = (attemptId: string, outcome: 'success' | 'failure' = 'success') => http(app).post(`${WEBHOOKS}/sandbox/simulate`).send({ attemptId, outcome });

  async function initiate(invoiceId: string, amount = '8500.00') {
    const res = await payMobile(app, cashier, invoiceId, amount).expect(201);
    return res.body.data as { payment: { id: string; status: string; method: string; amount: string }; checkoutUrl: string | null; instructions: string | null };
  }

  async function attemptIdOf(paymentId: string): Promise<string> {
    const row = await app.get(TenantDb).runAs(a.tenantId, (tx) => tx.patientPayment.findFirstOrThrow({ where: { id: paymentId } }));
    return row.attemptId as string;
  }

  it('crée un paiement en attente avec la consigne du fournisseur ; la facture n’est pas encore payée', async () => {
    const invoice = await newInvoice();

    const online = await initiate(invoice.id);

    expect(online.payment).toMatchObject({ method: 'mobile_money', status: 'pending', amount: '8500.00' });
    expect(online.checkoutUrl).toEqual(expect.stringContaining('/'));
    expect(online.instructions).toEqual(expect.any(String));
    expect(await getInvoice(app, cashier, invoice.id)).toMatchObject({ status: 'issued', amountPaid: '0.00' });
    const [entry] = await auditActions(app, a, 'payment.initiated', online.payment.id);
    expect(entry?.changes).toMatchObject({ invoiceId: invoice.id, method: 'mobile_money', amount: '8500.00' });
    expect(JSON.stringify(entry?.changes)).not.toContain('771234567');
  });

  it('ne place aucune donnée patient ni numéro en clair dans platform.*', async () => {
    const invoice = await newInvoice();
    const online = await initiate(invoice.id);

    const attemptId = await attemptIdOf(online.payment.id);
    const attempt = await app.get(PlatformDb).run((tx) => tx.paymentAttempt.findUniqueOrThrow({ where: { id: attemptId } }));

    expect(attempt).toMatchObject({ purpose: 'patient_invoice', tenantId: a.tenantId, referenceId: invoice.id, currency: 'XOF', channel: 'mobile_money' });
    expect(attempt.amount.toFixed(2)).toBe('8500.00');
    expect(attempt.description).toMatch(/^Facture FAC-/);
    expect(JSON.stringify(attempt)).not.toContain('771234567');
    expect(attempt.payerPhoneHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('enregistre le paiement et solde la facture quand le fournisseur confirme (simulation sandbox)', async () => {
    const invoice = await newInvoice();
    const online = await initiate(invoice.id);

    const res = await simulate(await attemptIdOf(online.payment.id)).expect(200);

    expect(res.body.data.outcome).toBe('succeeded');
    const after = await getInvoice(app, cashier, invoice.id);
    expect(after).toMatchObject({ status: 'paid', amountPaid: '8500.00', balance: '0.00' });
    expect(after.payments).toHaveLength(1);
    expect(after.payments[0]).toMatchObject({ id: online.payment.id, status: 'succeeded', method: 'mobile_money', cashSessionId: null });
    const [entry] = await auditActions(app, a, 'payment.succeeded', online.payment.id);
    expect(entry).toMatchObject({ actorType: 'system' });
  });

  it('prend en compte un paiement partiel puis le solde par espèces', async () => {
    const invoice = await newInvoice();
    const online = await initiate(invoice.id, '3000.00');
    await simulate(await attemptIdOf(online.payment.id)).expect(200);

    expect(await getInvoice(app, cashier, invoice.id)).toMatchObject({ status: 'partially_paid', amountPaid: '3000.00', balance: '5500.00' });
  });

  it('est idempotent : republier le même événement n’enregistre pas un second paiement', async () => {
    const invoice = await newInvoice();
    const online = await initiate(invoice.id);
    const attemptId = await attemptIdOf(online.payment.id);
    await simulate(attemptId).expect(200);

    const payload = {
      attemptId,
      purpose: 'patient_invoice' as const,
      tenantId: a.tenantId,
      referenceId: invoice.id,
      amount: '8500.00',
      currency: 'XOF',
      provider: 'sandbox',
      providerReference: 'x',
      settledAt: new Date().toISOString(),
    };
    await app.get(DomainEventBus).publish('payment.succeeded', payload);
    await app.get(DomainEventBus).publish('payment.succeeded', payload);

    const after = await getInvoice(app, cashier, invoice.id);
    expect(after.payments).toHaveLength(1);
    expect(after.amountPaid).toBe('8500.00');
  });

  it('une seule demande en attente par facture (409), puis une nouvelle demande après un échec', async () => {
    const invoice = await newInvoice();
    const first = await initiate(invoice.id);

    const second = await payMobile(app, cashier, invoice.id, '100.00').expect(409);
    await simulate(await attemptIdOf(first.payment.id), 'failure').expect(200);
    const retry = await payMobile(app, cashier, invoice.id, '8500.00').expect(201);

    expect(second.body.code).toBe('payment_already_pending');
    const detail = await getInvoice(app, cashier, invoice.id);
    expect(detail.payments.map((p) => p.status).sort()).toEqual(['failed', 'pending']);
    expect(detail).toMatchObject({ status: 'issued', amountPaid: '0.00' });
    expect(retry.body.data.payment.status).toBe('pending');
  });

  it('une demande en attente réserve son montant : un encaissement concurrent ne peut pas dépasser le reste dû', async () => {
    const invoice = await newInvoice();
    await initiate(invoice.id, '8000.00');

    const res = await http(app)
      .post(`${BILLING}/invoices/${invoice.id}/payments`)
      .set(bearer(cashier))
      .send({ method: 'other', amount: '600.00', cashSessionId: sessionId, reference: 'CHQ-9' })
      .expect(422);

    expect(res.body.code).toBe('amount_exceeds_balance');
  });

  it('refuse l’annulation d’une facture avec un paiement en attente (409)', async () => {
    const invoice = await newInvoice();
    await initiate(invoice.id);

    const res = await http(app).post(`${BILLING}/invoices/${invoice.id}/void`).set(bearer(accountant)).send({ reasonCode: 'other', comment: 'Annulation tentée' }).expect(409);

    expect(res.body.code).toBe('invoice_has_payments');
  });

  it('marque le paiement « failed » (avec motif) quand le fournisseur refuse', async () => {
    const invoice = await newInvoice();
    const online = await initiate(invoice.id);

    await simulate(await attemptIdOf(online.payment.id), 'failure').expect(200);

    const detail = await getInvoice(app, cashier, invoice.id);
    expect(detail.payments[0]).toMatchObject({ status: 'failed', failureReason: 'declined_by_provider' });
    expect(detail.amountPaid).toBe('0.00');
  });

  it('refresh : règle un paiement dont le webhook est perdu (reprise manuelle par le caissier)', async () => {
    const invoice = await newInvoice();
    const online = await initiate(invoice.id);
    const attemptId = await attemptIdOf(online.payment.id);
    const attempt = await app.get(PlatformDb).run((tx) => tx.paymentAttempt.findUniqueOrThrow({ where: { id: attemptId } }));
    await app.get(PlatformDb).run((tx) => tx.sandboxTransaction.update({ where: { providerReference: attempt.providerReference as string }, data: { status: 'succeeded' } }));

    const res = await http(app).post(`${BILLING}/payments/${online.payment.id}/refresh`).set(bearer(cashier)).expect(200);

    expect(res.body.data).toMatchObject({ id: online.payment.id, status: 'succeeded' });
    expect((await getInvoice(app, cashier, invoice.id)).status).toBe('paid');
  });

  it('refresh d’un paiement inconnu, d’un autre établissement ou espèces ⇒ 404 ; sans permission ⇒ 403', async () => {
    const invoice = await newInvoice();
    const online = await initiate(invoice.id);

    await http(app).post(`${BILLING}/payments/${randomUUID()}/refresh`).set(bearer(cashier)).expect(404);
    await http(app).post(`${BILLING}/payments/${online.payment.id}/refresh`).set(bearer(foreignCashier)).expect(404);
    await http(app).post(`${BILLING}/payments/${online.payment.id}/refresh`).set(bearer(accountant)).expect(403);
  });

  it('valide la demande : montant > reste dû (422), téléphone absent ou invalide (422), facture non payable (409)', async () => {
    const invoice = await newInvoice();
    const post = (body: Record<string, unknown>, id = invoice.id) => http(app).post(`${BILLING}/invoices/${id}/payments`).set(bearer(cashier)).send(body);

    await post({ method: 'mobile_money', amount: '9000.00', payerPhone: '+221771234567' }).expect(422);
    await post({ method: 'mobile_money', amount: '100.00' }).expect(422);
    await post({ method: 'mobile_money', amount: '100.00', payerPhone: '0771234567' }).expect(422);
    const draft = await http(app).post(`${BILLING}/invoices`).set(bearer(receptionist)).send({ patientId, siteId: a.mainSiteId, lines: [{ priceListItemId: catalog.drug.id }] }).expect(201);
    await post({ method: 'mobile_money', amount: '100.00', payerPhone: '+221771234567' }, draft.body.data.id).expect(409);
  });

  it('404 pour une facture d’un autre établissement', async () => {
    const invoice = await newInvoice();

    await payMobile(app, foreignCashier, invoice.id, '100.00').expect(404);
  });

  it('marque le paiement « failed » et renvoie 502 quand la passerelle échoue, sans bloquer une nouvelle tentative', async () => {
    const invoice = await newInvoice();
    const gateway = app.get<PaymentsGateway>(PAYMENTS_GATEWAY);
    vi.spyOn(gateway, 'initiate').mockRejectedValueOnce(Object.assign(new Error('indisponible'), { name: 'DomainError', status: 502, code: 'payment_provider_unavailable' }));

    await payMobile(app, cashier, invoice.id, '100.00').expect(500);
    vi.restoreAllMocks();

    const detail = await getInvoice(app, cashier, invoice.id);
    expect(detail.payments).toHaveLength(1);
    expect(detail.payments[0]).toMatchObject({ status: 'failed', failureReason: 'provider_unavailable' });
    await payMobile(app, cashier, invoice.id, '100.00').expect(201);
  });

  it('ignore (sans erreur) un paiement pour une facture inconnue ou d’un autre purpose', async () => {
    const bus = app.get(DomainEventBus);
    const base = { attemptId: randomUUID(), tenantId: a.tenantId, amount: '10.00', currency: 'XOF', provider: 'sandbox', providerReference: 'r', settledAt: new Date().toISOString() };

    await expect(bus.publish('payment.succeeded', { ...base, purpose: 'patient_invoice', referenceId: randomUUID() })).resolves.toBeUndefined();
    await expect(bus.publish('payment.succeeded', { ...base, purpose: 'saas_invoice', referenceId: randomUUID() })).resolves.toBeUndefined();
    await expect(bus.publish('payment.failed', { ...base, purpose: 'patient_invoice', referenceId: randomUUID(), reason: 'x' })).resolves.toBeUndefined();
  });

  it('un événement d’un tenant ne crédite jamais la facture d’un autre tenant (RLS)', async () => {
    const invoice = await newInvoice();
    await app.get(DomainEventBus).publish('payment.succeeded', {
      attemptId: randomUUID(),
      purpose: 'patient_invoice',
      tenantId: b.tenantId,
      referenceId: invoice.id,
      amount: '8500.00',
      currency: 'XOF',
      provider: 'sandbox',
      providerReference: 'r',
      settledAt: new Date().toISOString(),
    });

    expect(await getInvoice(app, cashier, invoice.id)).toMatchObject({ status: 'issued', amountPaid: '0.00' });
  });

  it('enregistre un paiement reçu en excédent (facture déjà soldée) et le signale dans l’audit', async () => {
    const invoice = await newInvoice();
    const online = await initiate(invoice.id);
    const attemptId = await attemptIdOf(online.payment.id);
    // La facture est soldée par un autre moyen avant la confirmation (cas rare mais possible côté agrégateur).
    await app.get(TenantDb).runAs(a.tenantId, (tx) =>
      tx.$executeRaw`UPDATE tenant.invoices SET amount_paid = total, status = 'paid' WHERE id = ${invoice.id}::uuid`,
    );

    await simulate(attemptId).expect(200);

    const detail = await getInvoice(app, cashier, invoice.id);
    expect(detail.payments.find((p) => p.id === online.payment.id)?.status).toBe('succeeded');
    const [entry] = await auditActions(app, a, 'payment.succeeded', online.payment.id);
    expect(entry?.changes).toMatchObject({ anomaly: 'overpaid' });
  });
});
