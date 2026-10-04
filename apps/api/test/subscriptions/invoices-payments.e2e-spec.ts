import type { INestApplication } from '@nestjs/common';
import type { SaasInvoiceView } from '@ghmt/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlatformDb } from '../../src/infrastructure/prisma/platform-db.service';
import { InvoiceIssuerService } from '../../src/modules/subscriptions/services/invoice-issuer.service';
import { createTenantFixture, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { bearer, http } from '../helpers/platform';
import { createTestApp } from '../helpers/test-app';
import {
  MS_PER_DAY,
  PAYER_PHONE,
  SUBSCRIPTION,
  createDoubles,
  invoicesOf,
  openConversionInvoice,
  publishPaymentSucceeded,
  readSubscription,
  recordStatusChanges,
} from './subscription-fixtures';

const UNKNOWN_ID = '0198a000-0000-7000-8000-0000000000ff';

describe('subscriptions : factures SaaS et paiement', () => {
  const doubles = createDoubles();
  let app: INestApplication;
  let a: TenantFixture;
  let b: TenantFixture;
  let receptionist: UserFixture;
  let invoice: SaasInvoiceView;
  let events: ReturnType<typeof recordStatusChanges>;

  const pay = (tenant: Pick<TenantFixture, 'adminToken'>, id: string, body: Record<string, unknown> = { payerPhone: PAYER_PHONE }) =>
    http(app).post(`${SUBSCRIPTION}/invoices/${id}/pay`).set(bearer(tenant.adminToken)).send(body);

  beforeAll(async () => {
    app = await createTestApp({}, { providerOverrides: doubles.overrides });
    events = recordStatusChanges(app);
    [a, b] = await Promise.all([
      createTenantFixture(app, { prefix: 'inv-a', subscriptionPlan: 'trial' }),
      createTenantFixture(app, { prefix: 'inv-b', subscriptionPlan: 'trial' }),
    ]);
    receptionist = await createUserWithRole(app, a, 'receptionist');
    invoice = await openConversionInvoice(app, a);
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('consultation', () => {
    it('liste les factures du tenant (jamais les brouillons), filtrables par statut, paginées', async () => {
      const list = await invoicesOf(app, a);
      expect(list.map((i) => i.id)).toEqual([invoice.id]);
      expect(await invoicesOf(app, a, { status: 'paid' })).toHaveLength(0);
      const page = await http(app).get(`${SUBSCRIPTION}/invoices`).query({ limit: 1 }).set(bearer(a.adminToken)).expect(200);
      expect(page.body.meta.pagination).toMatchObject({ limit: 1, hasMore: false });
      await http(app).get(`${SUBSCRIPTION}/invoices`).query({ status: 'brouillon' }).set(bearer(a.adminToken)).expect(422);
      await http(app).get(`${SUBSCRIPTION}/invoices`).query({ cursor: '%%%' }).set(bearer(a.adminToken)).expect(422);
    });

    it('cloisonne les établissements et exige la permission', async () => {
      expect(await invoicesOf(app, b)).toHaveLength(0);
      await http(app).get(`${SUBSCRIPTION}/invoices`).set(bearer(receptionist.token)).expect(403);
      await http(app).get(`${SUBSCRIPTION}/invoices`).expect(401);
    });
  });

  describe('POST /subscription/invoices/:id/pay', () => {
    it('lance le paiement via PAYMENTS_GATEWAY (finalité saas_invoice, montant exact, numéro non journalisé)', async () => {
      const res = await pay(a, invoice.id).expect(200);

      expect(res.body.data).toEqual({
        attemptId: expect.any(String),
        status: 'pending',
        provider: 'sandbox',
        checkoutUrl: expect.stringContaining(invoice.id),
        instructions: expect.any(String),
      });
      const call = doubles.gateway.initiated.at(-1)!;
      expect(call).toMatchObject({
        purpose: 'saas_invoice',
        tenantId: a.tenantId,
        referenceId: invoice.id,
        amount: invoice.total,
        currency: 'XOF',
        channel: 'mobile_money',
        payerPhone: PAYER_PHONE,
        description: `Facture ${invoice.number}`,
      });
      expect(call.idempotencyKey).toContain(invoice.id);
      expect(call.idempotencyKey).not.toContain(PAYER_PHONE);
    });

    it('un double-clic réutilise la même tentative (clé d’idempotence stable)', async () => {
      const first = await pay(a, invoice.id).expect(200);
      const second = await pay(a, invoice.id).expect(200);
      expect(second.body.data.attemptId).toBe(first.body.data.attemptId);
    });

    it('audite l’initiation côté tenant sans le numéro de téléphone', async () => {
      const { TenantDb } = await import('../../src/infrastructure/prisma/tenant-db.service');
      const entries = await app.get(TenantDb).runAs(a.tenantId, (tx) => tx.auditLog.findMany({ where: { action: 'subscription.invoice_payment_initiated' }, select: { changes: true } }));
      expect(entries.length).toBeGreaterThan(0);
      expect(JSON.stringify(entries)).not.toContain(PAYER_PHONE);
    });

    it('refuse un numéro invalide (422), l’absence de permission (403) et la facture d’un autre tenant (404)', async () => {
      await pay(a, invoice.id, { payerPhone: '0771234567' }).expect(422);
      await pay(a, invoice.id, {}).expect(422);
      await http(app).post(`${SUBSCRIPTION}/invoices/${invoice.id}/pay`).set(bearer(receptionist.token)).send({ payerPhone: PAYER_PHONE }).expect(403);
      const cross = await pay(b, invoice.id).expect(404);
      expect(cross.body.code).toBe('not_found');
      await pay(a, UNKNOWN_ID).expect(404);
      await pay(a, 'pas-un-uuid').expect(404);
    });

    it('refuse une facture annulée ou déjà payée (409 invoice_not_payable)', async () => {
      const tenant = await createTenantFixture(app, { prefix: 'inv-void', subscriptionPlan: 'trial' });
      const first = await openConversionInvoice(app, tenant);
      // Changer de plan annule la facture ouverte et en émet une autre.
      const second = await openConversionInvoice(app, tenant, 'basic');
      expect(second.id).not.toBe(first.id);
      const voided = await pay(tenant, first.id).expect(409);
      expect(voided.body.code).toBe('invoice_not_payable');

      await publishPaymentSucceeded(app, tenant, second);
      await pay(tenant, second.id).expect(409);
    });
  });

  describe('payment.succeeded (saas_invoice)', () => {
    let tenant: TenantFixture;
    let open: SaasInvoiceView;

    beforeAll(async () => {
      tenant = await createTenantFixture(app, { prefix: 'inv-evt', subscriptionPlan: 'trial' });
      open = await openConversionInvoice(app, tenant);
    });

    it('ignore les autres finalités, une facture inconnue, un autre tenant, un montant ou une devise incohérents', async () => {
      await publishPaymentSucceeded(app, tenant, open, { purpose: 'patient_invoice' });
      await publishPaymentSucceeded(app, tenant, { ...open, id: UNKNOWN_ID });
      await publishPaymentSucceeded(app, b, open);
      await publishPaymentSucceeded(app, tenant, { ...open, total: '1.00' });
      await publishPaymentSucceeded(app, tenant, { ...open, currency: 'EUR' });

      expect((await invoicesOf(app, tenant))[0]!.status).toBe('open');
      expect((await readSubscription(app, tenant.tenantId)).status).toBe('trial');
      const denied = await app.get(PlatformDb).run((tx) => tx.platformAuditLog.count({ where: { action: 'saas_invoice.payment_mismatch', resourceId: open.id } }));
      expect(denied).toBe(3);
    });

    it('règle la facture, active l’abonnement (ancienne fin + 1 mois), publie le changement de statut — idempotent', async () => {
      const before = await readSubscription(app, tenant.tenantId);

      await publishPaymentSucceeded(app, tenant, open);

      const paid = (await invoicesOf(app, tenant))[0]!;
      expect(paid.status).toBe('paid');
      expect(paid.paidAt).not.toBeNull();
      const after = await readSubscription(app, tenant.tenantId);
      expect(after.status).toBe('active');
      expect(after.currentPeriodStart.toISOString()).toBe(before.trialEndsAt!.toISOString());
      expect(after.currentPeriodEnd.getTime() - after.currentPeriodStart.getTime()).toBeGreaterThanOrEqual(28 * MS_PER_DAY);
      expect(events).toContainEqual({ from: 'trial', to: 'active', tenantId: tenant.tenantId });

      // Rejeu du même événement (webhook dupliqué) : aucun effet supplémentaire.
      const eventsBefore = events.length;
      await publishPaymentSucceeded(app, tenant, open);
      await publishPaymentSucceeded(app, tenant, open);
      const replayed = await readSubscription(app, tenant.tenantId);
      expect(replayed.currentPeriodEnd.toISOString()).toBe(after.currentPeriodEnd.toISOString());
      expect(events.length).toBe(eventsBefore);
      const paidLogs = await app.get(PlatformDb).run((tx) => tx.platformAuditLog.count({ where: { action: 'saas_invoice.paid', resourceId: open.id } }));
      expect(paidLogs).toBe(1);
    });

    it('un paiement concurrent du même événement n’applique qu’une période', async () => {
      const t = await createTenantFixture(app, { prefix: 'inv-conc', subscriptionPlan: 'trial' });
      const inv = await openConversionInvoice(app, t);
      const before = await readSubscription(app, t.tenantId);

      await Promise.all([publishPaymentSucceeded(app, t, inv), publishPaymentSucceeded(app, t, inv), publishPaymentSucceeded(app, t, inv)]);

      const after = await readSubscription(app, t.tenantId);
      expect(after.status).toBe('active');
      expect(after.currentPeriodStart.toISOString()).toBe(before.trialEndsAt!.toISOString());
      const count = await app.get(PlatformDb).run((tx) => tx.platformAuditLog.count({ where: { action: 'saas_invoice.paid', resourceId: inv.id } }));
      expect(count).toBe(1);
    });

    it('un paiement reçu pour une facture annulée n’est ni appliqué ni rejoué : tracé pour rapprochement', async () => {
      const t = await createTenantFixture(app, { prefix: 'inv-void2', subscriptionPlan: 'trial' });
      const first = await openConversionInvoice(app, t);
      await openConversionInvoice(app, t, 'basic');

      await expect(publishPaymentSucceeded(app, t, first)).resolves.toBeUndefined();

      expect((await readSubscription(app, t.tenantId)).status).toBe('trial');
      const logged = await app.get(PlatformDb).run((tx) => tx.platformAuditLog.count({ where: { action: 'saas_invoice.payment_on_unpayable_invoice', resourceId: first.id } }));
      expect(logged).toBe(1);
    });
  });

  describe('numérotation GHMT-{PAYS}-{AAAA}-{000001} sans trou', () => {
    it('attribue des numéros consécutifs sous concurrence (aucun doublon, aucun trou)', async () => {
      const tenants = await Promise.all(Array.from({ length: 6 }, (_, i) => createTenantFixture(app, { prefix: `inv-num${i}`, subscriptionPlan: 'trial' })));

      const issued = await Promise.all(tenants.map((t) => openConversionInvoice(app, t)));

      const numbers = issued.map((i) => i.number);
      expect(new Set(numbers).size).toBe(numbers.length);
      const prefix = numbers[0]!.slice(0, numbers[0]!.lastIndexOf('-') + 1);
      const all = await app.get(PlatformDb).run((tx) => tx.saasInvoice.findMany({ where: { number: { startsWith: prefix } }, select: { number: true } }));
      const sequence = all.map((i) => Number(i.number.slice(prefix.length))).sort((x, y) => x - y);
      expect(sequence).toEqual(Array.from({ length: sequence.length }, (_, i) => i + 1));
    });

    it('n’avance pas le compteur quand la transaction d’émission est annulée', async () => {
      const t = await createTenantFixture(app, { prefix: 'inv-rb', subscriptionPlan: 'trial' });
      const sub = await readSubscription(app, t.tenantId);
      const plan = await app.get(PlatformDb).run((tx) => tx.plan.findUniqueOrThrow({ where: { id: sub.planId } }));
      const year = new Date().getUTCFullYear();
      const counter = () => app.get(PlatformDb).run((tx) => tx.saasInvoiceCounter.findUnique({ where: { countryCode_year: { countryCode: 'SN', year } } }));
      const before = (await counter())?.lastValue ?? 0;

      await expect(
        app.get(PlatformDb).run(async (tx) => {
          await app.get(InvoiceIssuerService).issueRecurring(tx, {
            subscription: sub,
            plan,
            billingPeriod: 'monthly',
            kind: 'conversion',
            periodStart: new Date(Date.now() + 90 * MS_PER_DAY),
            now: new Date(),
            actor: { type: 'system' },
          });
          throw new Error('annulation volontaire');
        }),
      ).rejects.toThrow('annulation volontaire');

      expect((await counter())?.lastValue ?? 0).toBe(before);
    });
  });

  describe('immuabilité d’une facture émise (trigger SQL)', () => {
    it('refuse la modification des montants, la suppression et le changement de lignes', async () => {
      const db = app.get(PlatformDb);
      await expect(db.run((tx) => tx.saasInvoice.update({ where: { id: invoice.id }, data: { total: '1.00', subtotal: '1.00', taxAmount: '0.00' } }))).rejects.toThrow();
      await expect(db.run((tx) => tx.saasInvoice.update({ where: { id: invoice.id }, data: { number: 'GHMT-SN-2026-999999' } }))).rejects.toThrow();
      await expect(db.run((tx) => tx.saasInvoice.delete({ where: { id: invoice.id } }))).rejects.toThrow();
      await expect(db.run((tx) => tx.saasInvoiceLine.updateMany({ where: { invoiceId: invoice.id }, data: { amount: '1.00' } }))).rejects.toThrow();
      await expect(db.run((tx) => tx.saasInvoiceLine.deleteMany({ where: { invoiceId: invoice.id } }))).rejects.toThrow();
    });

    it('refuse une transition de statut illégale (une facture annulée ne redevient pas ouverte)', async () => {
      const t = await createTenantFixture(app, { prefix: 'inv-trans', subscriptionPlan: 'trial' });
      const first = await openConversionInvoice(app, t);
      await openConversionInvoice(app, t, 'basic'); // annule `first`
      await expect(app.get(PlatformDb).run((tx) => tx.saasInvoice.update({ where: { id: first.id }, data: { status: 'open' } }))).rejects.toThrow();
    });

    it('impose les contraintes de montant (total = sous-total + taxe) et de format du numéro', async () => {
      const sub = await readSubscription(app, a.tenantId);
      const base = {
        tenantId: a.tenantId,
        subscriptionId: sub.id,
        planId: sub.planId,
        countryCode: 'SN',
        status: 'draft' as const,
        kind: 'renewal' as const,
        billingPeriod: 'monthly' as const,
        currency: 'XOF',
        taxRate: '0.18',
        periodStart: new Date(Date.now() + 200 * MS_PER_DAY),
        periodEnd: new Date(Date.now() + 230 * MS_PER_DAY),
        issuedAt: new Date(),
        dueAt: new Date(),
      };
      const db = app.get(PlatformDb);
      await expect(db.run((tx) => tx.saasInvoice.create({ data: { ...base, number: 'GHMT-SN-2026-900001', subtotal: '100', taxAmount: '18', total: '999' } }))).rejects.toThrow();
      await expect(db.run((tx) => tx.saasInvoice.create({ data: { ...base, number: 'FAC-1', subtotal: '100', taxAmount: '18', total: '118' } }))).rejects.toThrow();
    });
  });
});
