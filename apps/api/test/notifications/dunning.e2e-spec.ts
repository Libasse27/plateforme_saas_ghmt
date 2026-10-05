import type { INestApplication } from '@nestjs/common';
import type { SaasInvoiceView } from '@ghmt/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAILER } from '../../src/common/mail/mailer';
import { MemoryMailer } from '../../src/common/mail/memory-mailer';
import { PlatformDb } from '../../src/infrastructure/prisma/platform-db.service';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { SaasDunningJob } from '../../src/modules/notifications/jobs/saas-dunning.job';
import { createTenantFixture, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { createDoubles, openConversionInvoice, publishPaymentSucceeded } from '../subscriptions/subscription-fixtures';
import { runDispatcher } from './dispatch-fixtures';
import { API, DAY_MS, bearer, http, notificationsOf } from './notification-fixtures';

describe('relances de factures SaaS', () => {
  const doubles = createDoubles();
  let app: INestApplication;
  let mailer: MemoryMailer;

  beforeAll(async () => {
    app = await createTestApp({}, { providerOverrides: doubles.overrides });
    mailer = app.get(MAILER) as MemoryMailer;
  });

  afterAll(async () => {
    await app?.close();
  });

  /** Établissement en essai converti : facture ouverte, un administrateur et un directeur. */
  async function openInvoice(prefix: string): Promise<{ tenant: TenantFixture; invoice: SaasInvoiceView; dueAt: Date; director: UserFixture }> {
    const tenant = await createTenantFixture(app, { prefix, subscriptionPlan: 'trial' });
    const director = await createUserWithRole(app, tenant, 'director');
    await createUserWithRole(app, tenant, 'receptionist');
    const invoice = await openConversionInvoice(app, tenant);
    const stored = await app.get(PlatformDb).run((tx) => tx.saasInvoice.findUniqueOrThrow({ where: { id: invoice.id } }));
    return { tenant, invoice, dueAt: stored.dueAt, director };
  }

  const dunning = (now: Date, tenant: TenantFixture) => app.get(SaasDunningJob).runOnce(now, { tenantIds: [tenant.tenantId] });
  const at = (dueAt: Date, offsetDays: number, extraMs = 0): Date => new Date(dueAt.getTime() + offsetDays * DAY_MS + extraMs);
  const invoiceRows = (tenant: TenantFixture, invoice: SaasInvoiceView) => notificationsOf(app, tenant, { subjectType: 'saas_invoice', subjectId: invoice.id });

  it('ne crée rien avant la première étape (J-7)', async () => {
    const { tenant, invoice, dueAt } = await openInvoice('dun-early');

    await dunning(at(dueAt, -8), tenant);

    expect(await invoiceRows(tenant, invoice)).toHaveLength(0);
  });

  it('J-7 : e-mail et in-app aux administrateurs (pas aux directeurs, pas au personnel), envoyés par le dispatcher', async () => {
    const { tenant, invoice, dueAt } = await openInvoice('dun-d7');
    const now = at(dueAt, -7, 60_000);

    await dunning(now, tenant);
    mailer.clear();
    await runDispatcher(app, now, tenant);

    const rows = await invoiceRows(tenant, invoice);
    expect(rows.map((r) => [r.typeCode, r.channel, r.recipientId]).sort()).toEqual(
      [
        ['subscription.invoice_issued', 'email', tenant.adminUserId],
        ['subscription.invoice_issued', 'inapp', tenant.adminUserId],
      ].sort(),
    );
    expect(rows.find((r) => r.channel === 'email')).toMatchObject({ status: 'sent', category: 'administrative', subjectVersion: '-7', context: { invoiceNumber: invoice.number, offsetDays: -7, currency: invoice.currency, amount: invoice.total } });
    expect(rows.find((r) => r.channel === 'inapp')?.status).toBe('delivered');
    const mail = mailer.lastTo(tenant.adminEmail);
    expect(mail?.subject).toContain(invoice.number);
    expect(mail?.text).toContain('/abonnement');
    const inbox = await http(app).get(`${API}/notifications/inbox`).set(bearer(tenant.adminToken)).expect(200);
    expect(inbox.body.data[0]).toMatchObject({ typeCode: 'subscription.invoice_issued', link: '/abonnement' });
    expect((await http(app).get(`${API}/notifications/inbox/unread-count`).set(bearer(tenant.adminToken))).body.data.count).toBe(1);
  });

  it('J+7 : relance de retard envoyée aussi aux directeurs, sans rattrapage en rafale des étapes manquées', async () => {
    const { tenant, invoice, dueAt, director } = await openInvoice('dun-d7late');

    await dunning(at(dueAt, 7, 60_000), tenant);

    const rows = await invoiceRows(tenant, invoice);
    expect(new Set(rows.map((r) => r.typeCode))).toEqual(new Set(['subscription.payment_overdue']));
    expect(rows.map((r) => r.recipientId).sort()).toEqual([tenant.adminUserId, tenant.adminUserId, director.userId, director.userId].sort());
    expect(rows).toHaveLength(4);
  });

  it('J+3 : relance de retard réservée aux administrateurs ; dernière étape : avis de suspension', async () => {
    const early = await openInvoice('dun-d3');
    const last = await openInvoice('dun-d15');

    await dunning(at(early.dueAt, 3, 60_000), early.tenant);
    await dunning(at(last.dueAt, 15, 60_000), last.tenant);

    const earlyRows = await invoiceRows(early.tenant, early.invoice);
    expect(earlyRows.map((r) => [r.typeCode, r.recipientId]).sort()).toEqual([['subscription.payment_overdue', early.tenant.adminUserId], ['subscription.payment_overdue', early.tenant.adminUserId]]);
    expect(new Set((await invoiceRows(last.tenant, last.invoice)).map((r) => r.typeCode))).toEqual(new Set(['subscription.suspension_notice']));
  });

  it('est idempotent : une seconde passe à la même étape ne crée rien, la suivante crée la nouvelle étape seule', async () => {
    const { tenant, invoice, dueAt } = await openInvoice('dun-idem');
    await dunning(at(dueAt, -3, 60_000), tenant);
    const before = await invoiceRows(tenant, invoice);

    await dunning(at(dueAt, -3, 3_600_000), tenant);
    expect(await invoiceRows(tenant, invoice)).toHaveLength(before.length);
    await dunning(at(dueAt, 0, 60_000), tenant);

    const rows = await invoiceRows(tenant, invoice);
    expect(rows.map((r) => r.subjectVersion).sort()).toEqual(['-3', '-3', '0', '0']);
    expect(rows.filter((r) => r.subjectVersion === '0').every((r) => r.typeCode === 'subscription.payment_reminder')).toBe(true);
  });

  it('le paiement supprime les relances en attente (invoice_settled) et plus aucune étape n’est créée', async () => {
    const { tenant, invoice, dueAt } = await openInvoice('dun-paid');
    await dunning(at(dueAt, -3, 60_000), tenant);
    expect((await invoiceRows(tenant, invoice)).every((r) => r.status === 'queued')).toBe(true);

    await publishPaymentSucceeded(app, tenant, invoice);
    await dunning(at(dueAt, 3, 60_000), tenant);

    const rows = await invoiceRows(tenant, invoice);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.status, r.suppressionReason])).toEqual([['suppressed', 'invoice_settled'], ['suppressed', 'invoice_settled']]);
  });

  it('un paiement hors événement (facture réglée entre la planification et l’envoi) supprime la relance à l’envoi', async () => {
    const { tenant, invoice, dueAt } = await openInvoice('dun-race');
    const now = at(dueAt, -3, 60_000);
    await dunning(now, tenant);
    await app.get(PlatformDb).run((tx) => tx.saasInvoice.update({ where: { id: invoice.id }, data: { status: 'paid', paidAt: new Date() } }));
    mailer.clear();

    await runDispatcher(app, now, tenant);

    const rows = await invoiceRows(tenant, invoice);
    expect(rows.map((r) => [r.status, r.suppressionReason])).toEqual([['suppressed', 'invoice_settled'], ['suppressed', 'invoice_settled']]);
    expect(mailer.sent.filter((m) => m.to === tenant.adminEmail)).toHaveLength(0);
  });

  it('ignore les factures d’autres établissements (tenantIds) et ne touche pas aux factures payées', async () => {
    const a = await openInvoice('dun-scope-a');
    const b = await openInvoice('dun-scope-b');

    const report = await dunning(at(a.dueAt, -3, 60_000), a.tenant);

    expect(report.examined).toBe(1);
    expect(await invoiceRows(b.tenant, b.invoice)).toHaveLength(0);
  });

  it('écrit la langue du destinataire : un administrateur en anglais reçoit le modèle anglais', async () => {
    const { tenant, invoice, dueAt } = await openInvoice('dun-en');
    await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.user.update({ where: { tenantId_id: { tenantId: tenant.tenantId, id: tenant.adminUserId } }, data: { locale: 'en' } }));
    const now = at(dueAt, -7, 60_000);
    await dunning(now, tenant);
    mailer.clear();

    await runDispatcher(app, now, tenant);

    expect(mailer.lastTo(tenant.adminEmail)?.subject).toContain('to pay');
    expect((await invoiceRows(tenant, invoice)).every((r) => r.locale === 'en')).toBe(true);
  });
});
