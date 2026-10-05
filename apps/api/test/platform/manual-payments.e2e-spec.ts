import type { INestApplication } from '@nestjs/common';
import type { SaasInvoiceView } from '@ghmt/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlatformDb } from '../../src/infrastructure/prisma/platform-db.service';
import { createTenantFixture, type TenantFixture } from '../helpers/fixtures';
import { PLATFORM, bearer, createPlatformUser, http, type PlatformUserFixture } from '../helpers/platform';
import { createTestApp } from '../helpers/test-app';
import { openConversionInvoice, readSubscription, recordStatusChanges } from '../subscriptions/subscription-fixtures';

describe('platform : paiements manuels (quatre yeux)', () => {
  let app: INestApplication;
  let enterer: PlatformUserFixture;
  let validator: PlatformUserFixture;
  let admin: PlatformUserFixture;
  let support: PlatformUserFixture;
  let events: ReturnType<typeof recordStatusChanges>;

  const payload = (invoice: SaasInvoiceView, overrides: Record<string, unknown> = {}) => ({
    amount: invoice.total,
    method: 'bank_transfer',
    reference: 'VIR-2026-0042',
    receivedAt: new Date().toISOString(),
    ...overrides,
  });
  const enter = (user: PlatformUserFixture, invoice: SaasInvoiceView, overrides: Record<string, unknown> = {}) =>
    http(app).post(`${PLATFORM}/invoices/${invoice.id}/manual-payments`).set(bearer(user.token)).send(payload(invoice, overrides));
  const decide = (user: PlatformUserFixture, paymentId: string, action: 'validate' | 'reject', body: Record<string, unknown> = {}) =>
    http(app).post(`${PLATFORM}/invoices/manual-payments/${paymentId}/${action}`).set(bearer(user.token)).send(body);
  const newInvoice = async (prefix: string): Promise<{ tenant: TenantFixture; invoice: SaasInvoiceView }> => {
    const tenant = await createTenantFixture(app, { prefix, subscriptionPlan: 'trial' });
    return { tenant, invoice: await openConversionInvoice(app, tenant) };
  };

  beforeAll(async () => {
    app = await createTestApp();
    events = recordStatusChanges(app);
    [enterer, validator, admin, support] = await Promise.all([
      createPlatformUser(app, 'billing'),
      createPlatformUser(app, 'billing'),
      createPlatformUser(app, 'super_admin'),
      createPlatformUser(app, 'support'),
    ]);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('saisie : crée un paiement en attente au montant exact de la facture et l’audite', async () => {
    const { tenant, invoice } = await newInvoice('mp-enter');

    const res = await enter(enterer, invoice).expect(201);

    expect(res.body.data).toMatchObject({
      invoiceId: invoice.id,
      invoiceNumber: invoice.number,
      tenantId: tenant.tenantId,
      amount: invoice.total,
      currency: 'XOF',
      method: 'bank_transfer',
      reference: 'VIR-2026-0042',
      status: 'pending',
      enteredBy: enterer.userId,
      decidedBy: null,
    });
    const audit = await app.get(PlatformDb).run((tx) => tx.platformAuditLog.findMany({ where: { action: 'manual_payment.entered', resourceId: res.body.data.id } }));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorUserId: enterer.userId, tenantId: tenant.tenantId });
  });

  it('saisie : refuse un montant différent (422), un doublon en attente (409), une facture inconnue (404), une entrée invalide (422)', async () => {
    const { invoice } = await newInvoice('mp-refus');

    const mismatch = await enter(enterer, invoice, { amount: '1.00' }).expect(422);
    expect(mismatch.body.code).toBe('amount_mismatch');
    await enter(enterer, invoice, { amount: invoice.total.replace('.00', '') }).expect(201);
    const duplicate = await enter(validator, invoice).expect(409);
    expect(duplicate.body.code).toBe('manual_payment_pending');

    await http(app)
      .post(`${PLATFORM}/invoices/0198a000-0000-7000-8000-0000000000ff/manual-payments`)
      .set(bearer(enterer.token))
      .send(payload(invoice))
      .expect(404);
    await enter(enterer, invoice, { method: 'bitcoin' }).expect(422);
    await enter(enterer, invoice, { reference: '' }).expect(422);
    await enter(enterer, invoice, { amount: '-5' }).expect(422);
  });

  it('permissions : support ne saisit ni ne valide ; un jeton tenant est refusé', async () => {
    const { tenant, invoice } = await newInvoice('mp-perm');
    await enter(support, invoice).expect(403);
    const entered = await enter(enterer, invoice).expect(201);
    await decide(support, entered.body.data.id, 'validate').expect(403);
    await http(app).post(`${PLATFORM}/invoices/${invoice.id}/manual-payments`).set(bearer(tenant.adminToken)).send(payload(invoice)).expect(401);
    await decide({ token: tenant.adminToken } as PlatformUserFixture, entered.body.data.id, 'validate').expect(401);
  });

  it('quatre yeux : le saisisseur ne peut ni valider ni rejeter son propre paiement (403, tracé)', async () => {
    const { invoice } = await newInvoice('mp-4eyes');
    const entered = await enter(enterer, invoice).expect(201);

    const validate = await decide(enterer, entered.body.data.id, 'validate').expect(403);
    const reject = await decide(enterer, entered.body.data.id, 'reject', { reason: 'Je me rejette moi-même' }).expect(403);

    expect(validate.body.code).toBe('four_eyes_required');
    expect(reject.body.code).toBe('four_eyes_required');
    const status = await app.get(PlatformDb).run((tx) => tx.manualPayment.findUniqueOrThrow({ where: { id: entered.body.data.id } }));
    expect(status.status).toBe('pending');
    const denied = await app.get(PlatformDb).run((tx) => tx.platformAuditLog.count({ where: { action: 'manual_payment.four_eyes_denied', resourceId: entered.body.data.id } }));
    expect(denied).toBe(2);
    expect((await readSubscriptionOf(invoice)).status).toBe('trial');
  });

  it('quatre yeux garanti en base : une contrainte CHECK interdit validated_by = entered_by', async () => {
    const { invoice } = await newInvoice('mp-check');
    const entered = await enter(enterer, invoice).expect(201);
    await expect(
      app
        .get(PlatformDb)
        .run((tx) =>
          tx.manualPayment.update({ where: { id: entered.body.data.id }, data: { status: 'validated', validatedBy: enterer.userId, decidedAt: new Date() } }),
        ),
    ).rejects.toThrow();
  });

  it('validation par un autre utilisateur : facture payée, abonnement actif, événement publié, audit complet', async () => {
    const { tenant, invoice } = await newInvoice('mp-validate');
    const entered = await enter(enterer, invoice).expect(201);

    const res = await decide(validator, entered.body.data.id, 'validate').expect(200);

    expect(res.body.data).toMatchObject({ status: 'validated', decidedBy: validator.userId, enteredBy: enterer.userId });
    const paid = await app.get(PlatformDb).run((tx) => tx.saasInvoice.findUniqueOrThrow({ where: { id: invoice.id } }));
    expect(paid).toMatchObject({ status: 'paid', paymentChannel: 'manual:bank_transfer' });
    const sub = await readSubscription(app, tenant.tenantId);
    expect(sub.status).toBe('active');
    expect(events).toContainEqual({ from: 'trial', to: 'active', tenantId: tenant.tenantId });
    const actions = await app.get(PlatformDb).run((tx) => tx.platformAuditLog.findMany({ where: { tenantId: tenant.tenantId }, select: { action: true } }));
    expect(actions.map((a) => a.action)).toEqual(expect.arrayContaining(['manual_payment.entered', 'manual_payment.validated', 'saas_invoice.paid', 'subscription.status_changed']));

    // Décision définitive : ni nouvelle validation, ni rejet, ni nouvelle saisie.
    expect((await decide(admin, entered.body.data.id, 'validate').expect(409)).body.code).toBe('manual_payment_decided');
    await decide(admin, entered.body.data.id, 'reject', { reason: 'Trop tard pour rejeter' }).expect(409);
    expect((await enter(enterer, invoice).expect(409)).body.code).toBe('invoice_not_payable');
  });

  it('un super_admin peut valider le paiement saisi par un billing', async () => {
    const { invoice } = await newInvoice('mp-admin');
    const entered = await enter(enterer, invoice).expect(201);
    await decide(admin, entered.body.data.id, 'validate').expect(200);
  });

  it('rejet motivé : la facture reste ouverte et une nouvelle saisie est possible', async () => {
    const { invoice } = await newInvoice('mp-reject');
    const entered = await enter(enterer, invoice).expect(201);

    await decide(validator, entered.body.data.id, 'reject', { reason: 'x' }).expect(422);
    const res = await decide(validator, entered.body.data.id, 'reject', { reason: 'Virement introuvable sur le relevé' }).expect(200);

    expect(res.body.data).toMatchObject({ status: 'rejected', rejectionReason: 'Virement introuvable sur le relevé', decidedBy: validator.userId });
    const row = await app.get(PlatformDb).run((tx) => tx.saasInvoice.findUniqueOrThrow({ where: { id: invoice.id } }));
    expect(row.status).toBe('open');
    await enter(enterer, invoice, { reference: 'VIR-CORRIGE-1' }).expect(201);
  });

  it('validations concurrentes : un seul règlement, l’autre reçoit 409', async () => {
    const { tenant, invoice } = await newInvoice('mp-race');
    const entered = await enter(enterer, invoice).expect(201);

    const results = await Promise.all([decide(validator, entered.body.data.id, 'validate'), decide(admin, entered.body.data.id, 'validate')]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const paidLogs = await app.get(PlatformDb).run((tx) => tx.platformAuditLog.count({ where: { action: 'saas_invoice.paid', tenantId: tenant.tenantId } }));
    expect(paidLogs).toBe(1);
  });

  it('liste filtrable par statut ; 404 pour un paiement ou une facture inconnus', async () => {
    const { invoice } = await newInvoice('mp-list');
    const entered = await enter(enterer, invoice).expect(201);

    const pending = await http(app).get(`${PLATFORM}/invoices/manual-payments`).query({ status: 'pending', limit: 100 }).set(bearer(admin.token)).expect(200);
    expect((pending.body.data as { id: string }[]).map((p) => p.id)).toContain(entered.body.data.id);
    await http(app).get(`${PLATFORM}/invoices/manual-payments`).query({ status: 'autre' }).set(bearer(admin.token)).expect(422);
    await decide(validator, '0198a000-0000-7000-8000-0000000000ff', 'validate').expect(404);
    await http(app).get(`${PLATFORM}/invoices/0198a000-0000-7000-8000-0000000000ff`).set(bearer(admin.token)).expect(404);
  });

  it('console factures : liste filtrée par établissement et détail avec lignes, sans brouillons', async () => {
    const { tenant, invoice } = await newInvoice('mp-inv');

    const list = await http(app).get(`${PLATFORM}/invoices`).query({ tenantId: tenant.tenantId }).set(bearer(admin.token)).expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ id: invoice.id, tenantId: tenant.tenantId, tenantSlug: tenant.slug, status: 'open' });
    const one = await http(app).get(`${PLATFORM}/invoices/${invoice.id}`).set(bearer(validator.token)).expect(200);
    expect(one.body.data.lines).toHaveLength(1);
    await http(app).get(`${PLATFORM}/invoices`).query({ status: 'open', limit: 1 }).set(bearer(admin.token)).expect(200);
    await http(app).get(`${PLATFORM}/invoices`).query({ tenantId: 'pas-un-uuid' }).set(bearer(admin.token)).expect(422);
  });

  async function readSubscriptionOf(invoice: SaasInvoiceView) {
    const row = await app.get(PlatformDb).run((tx) => tx.saasInvoice.findUniqueOrThrow({ where: { id: invoice.id } }));
    return readSubscription(app, row.tenantId);
  }
});
