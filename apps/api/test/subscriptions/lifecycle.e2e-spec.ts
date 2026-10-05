import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlatformDb } from '../../src/infrastructure/prisma/platform-db.service';
import { SubscriptionLifecycleService } from '../../src/modules/subscriptions/services/subscription-lifecycle.service';
import { createTenantFixture, createUserWithRole, type TenantFixture } from '../helpers/fixtures';
import { bearer, http } from '../helpers/platform';
import { createTestApp } from '../helpers/test-app';
import {
  MS_PER_DAY,
  SUBSCRIPTION,
  createDoubles,
  invoicesOf,
  makeActive,
  openConversionInvoice,
  publishPaymentSucceeded,
  readSubscription,
  recordStatusChanges,
  tenantStatusOf,
} from './subscription-fixtures';

const daysAfter = (date: Date, days: number): Date => new Date(date.getTime() + days * MS_PER_DAY);

describe('subscriptions : cycle de vie (horloge simulée)', () => {
  const doubles = createDoubles();
  let app: INestApplication;
  let lifecycle: SubscriptionLifecycleService;
  const changes = (): ReturnType<typeof recordStatusChanges> => (statusChanges ??= recordStatusChanges(app));
  let statusChanges: ReturnType<typeof recordStatusChanges> | undefined;

  const run = (tenant: TenantFixture, now: Date) => lifecycle.runLifecycle(now, { tenantIds: [tenant.tenantId] });
  const newTenant = (prefix: string) => createTenantFixture(app, { prefix, subscriptionPlan: 'trial' });

  beforeAll(async () => {
    app = await createTestApp({}, { providerOverrides: doubles.overrides });
    lifecycle = app.get(SubscriptionLifecycleService);
    changes();
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('essai', () => {
    it('émet la facture de conversion à J-7 de la fin d’essai, une seule fois (idempotent)', async () => {
      const tenant = await newTenant('lc-conv');
      const { trialEndsAt } = await readSubscription(app, tenant.tenantId);

      const early = await run(tenant, daysAfter(trialEndsAt!, -8));
      expect(early.invoicesIssued).toBe(0);
      expect(await invoicesOf(app, tenant)).toHaveLength(0);

      const due = await run(tenant, daysAfter(trialEndsAt!, -7));
      expect(due.invoicesIssued).toBe(1);
      const again = await run(tenant, daysAfter(trialEndsAt!, -3));
      expect(again.invoicesIssued).toBe(0);

      const [invoice, ...rest] = await invoicesOf(app, tenant);
      expect(rest).toHaveLength(0);
      expect(invoice).toMatchObject({
        kind: 'conversion',
        status: 'open',
        currency: 'XOF',
        subtotal: '75000.00',
        taxRate: '0.1800',
        taxAmount: '13500.00',
        total: '88500.00',
      });
      expect(invoice!.number).toMatch(/^GHMT-SN-\d{4}-\d{6}$/);
      expect(invoice!.periodStart).toBe(trialEndsAt!.toISOString());
      expect(invoice!.lines).toEqual([expect.objectContaining({ quantity: 1, unitPrice: '75000.00', amount: '75000.00' })]);
    });

    it('expire l’essai impayé : abonnement expired, établissement en lecture seule, soins préservés, événement publié', async () => {
      const tenant = await newTenant('lc-exp');
      const reception = await createUserWithRole(app, tenant, 'receptionist');
      const { trialEndsAt } = await readSubscription(app, tenant.tenantId);

      const report = await run(tenant, daysAfter(trialEndsAt!, 0.01));

      expect(report.transitions).toEqual([expect.objectContaining({ from: 'trial', to: 'expired', tenantId: tenant.tenantId })]);
      expect((await readSubscription(app, tenant.tenantId)).status).toBe('expired');
      expect(await tenantStatusOf(app, tenant.tenantId)).toBe('suspended');
      expect(changes()).toContainEqual({ from: 'trial', to: 'expired', tenantId: tenant.tenantId });

      await http(app).get('/api/v1/org/sites').set(bearer(tenant.adminToken)).expect(200);
      const denied = await http(app).post('/api/v1/org/sites').set(bearer(tenant.adminToken)).send({ code: 'X1', name: 'Bloqué' }).expect(403);
      expect(denied.body.code).toBe('subscription_suspended');
      const patient = await http(app)
        .post('/api/v1/patients')
        .set(bearer(reception.token))
        .send({ lastName: 'Urgence', firstName: 'Awa', sex: 'female', birthDate: '1990-01-01' });
      expect(patient.status).toBe(201);
    });

    it('réactive l’établissement quand la facture de conversion est payée après expiration', async () => {
      const tenant = await newTenant('lc-react');
      const { trialEndsAt } = await readSubscription(app, tenant.tenantId);
      await run(tenant, daysAfter(trialEndsAt!, -7));
      const [invoice] = await invoicesOf(app, tenant);
      await run(tenant, daysAfter(trialEndsAt!, 1));
      expect(await tenantStatusOf(app, tenant.tenantId)).toBe('suspended');

      const paidAt = daysAfter(trialEndsAt!, 2);
      await publishPaymentSucceeded(app, tenant, invoice!, { settledAt: paidAt.toISOString() });

      const sub = await readSubscription(app, tenant.tenantId);
      expect(sub.status).toBe('active');
      expect(sub.currentPeriodStart.toISOString()).toBe(paidAt.toISOString());
      expect(sub.currentPeriodEnd.getTime()).toBeGreaterThan(paidAt.getTime() + 27 * MS_PER_DAY);
      expect(await tenantStatusOf(app, tenant.tenantId)).toBe('active');
      await http(app).post('/api/v1/org/sites').set(bearer(tenant.adminToken)).send({ code: 'REOUV', name: 'Réouvert' }).expect(201);
    });

    it('paie avant la fin de l’essai : la période payée commence à la fin d’essai (aucun jour perdu)', async () => {
      const tenant = await newTenant('lc-early');
      const invoice = await openConversionInvoice(app, tenant);
      const before = await readSubscription(app, tenant.tenantId);

      await publishPaymentSucceeded(app, tenant, invoice);

      const sub = await readSubscription(app, tenant.tenantId);
      expect(sub.status).toBe('active');
      expect(sub.currentPeriodStart.toISOString()).toBe(before.trialEndsAt!.toISOString());
      expect(sub.currentPeriodEnd.getTime()).toBeGreaterThan(before.trialEndsAt!.getTime() + 27 * MS_PER_DAY);
    });
  });

  describe('abonnement actif non renouvelé', () => {
    it('émet la facture de renouvellement à J-7 puis suit past_due → grace → suspended → expired aux seuils de docs/05 A6', async () => {
      const tenant = await newTenant('lc-chain');
      const reception = await createUserWithRole(app, tenant, 'receptionist');
      const end = new Date(Date.now() + 40 * MS_PER_DAY);
      await makeActive(app, tenant.tenantId, end);

      expect((await run(tenant, daysAfter(end, -8))).invoicesIssued).toBe(0);
      expect((await run(tenant, daysAfter(end, -7))).invoicesIssued).toBe(1);
      const [renewal] = await invoicesOf(app, tenant);
      expect(renewal).toMatchObject({ kind: 'renewal', periodStart: end.toISOString() });

      await run(tenant, daysAfter(end, 0.01));
      expect((await readSubscription(app, tenant.tenantId)).status).toBe('past_due');
      expect(await tenantStatusOf(app, tenant.tenantId)).toBe('active');

      await run(tenant, daysAfter(end, 6.9));
      expect((await readSubscription(app, tenant.tenantId)).status).toBe('past_due');
      await run(tenant, daysAfter(end, 7));
      expect((await readSubscription(app, tenant.tenantId)).status).toBe('grace');

      // Période de grâce : actions administratives non essentielles bloquées, soins complets.
      const blocked = await http(app).post('/api/v1/iam/users').set(bearer(tenant.adminToken)).send({ fullName: 'Nouvel Agent', email: `n@${tenant.slug}.test` }).expect(403);
      expect(blocked.body.code).toBe('subscription_grace');
      await http(app).get('/api/v1/org/sites').set(bearer(tenant.adminToken)).expect(200);
      await http(app).post('/api/v1/org/sites').set(bearer(tenant.adminToken)).send({ code: 'GR1', name: 'Site en grâce' }).expect(201);
      const care = await http(app)
        .post('/api/v1/patients')
        .set(bearer(reception.token))
        .send({ lastName: 'Soin', firstName: 'Continu', sex: 'male', birthDate: '1985-05-05' });
      expect(care.status).toBe(201);

      await run(tenant, daysAfter(end, 14.9));
      expect((await readSubscription(app, tenant.tenantId)).status).toBe('grace');
      await run(tenant, daysAfter(end, 15));
      expect((await readSubscription(app, tenant.tenantId)).status).toBe('suspended');
      expect(await tenantStatusOf(app, tenant.tenantId)).toBe('suspended');

      await run(tenant, daysAfter(end, 74.9));
      expect((await readSubscription(app, tenant.tenantId)).status).toBe('suspended');
      await run(tenant, daysAfter(end, 75));
      expect((await readSubscription(app, tenant.tenantId)).status).toBe('expired');

      const audit = await app.get(PlatformDb).run((tx) => tx.platformAuditLog.findMany({ where: { tenantId: tenant.tenantId, action: 'subscription.status_changed' } }));
      expect(audit.map((l) => (l.changes as { to: string }).to)).toEqual(expect.arrayContaining(['past_due', 'grace', 'suspended', 'expired']));
    });

    it('rattrape plusieurs étapes en une exécution après une interruption du job', async () => {
      const tenant = await newTenant('lc-catchup');
      const end = new Date(Date.now() + 40 * MS_PER_DAY);
      await makeActive(app, tenant.tenantId, end);

      const report = await run(tenant, daysAfter(end, 80));

      expect(report.transitions.map((t) => t.to)).toEqual(['past_due', 'grace', 'suspended', 'expired']);
      expect((await readSubscription(app, tenant.tenantId)).status).toBe('expired');
    });

    it('le paiement du renouvellement en retard réactive l’abonnement : période = ancienne fin + 1 mois', async () => {
      const tenant = await newTenant('lc-late');
      const end = new Date(Date.now() + 40 * MS_PER_DAY);
      await makeActive(app, tenant.tenantId, end);
      await run(tenant, daysAfter(end, -7));
      const [renewal] = await invoicesOf(app, tenant);
      await run(tenant, daysAfter(end, 8));
      expect((await readSubscription(app, tenant.tenantId)).status).toBe('grace');

      await publishPaymentSucceeded(app, tenant, renewal!, { settledAt: daysAfter(end, 9).toISOString() });

      const sub = await readSubscription(app, tenant.tenantId);
      expect(sub.status).toBe('active');
      expect(sub.currentPeriodStart.toISOString()).toBe(end.toISOString());
      expect(sub.currentPeriodEnd.toISOString()).toBe(new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, end.getUTCDate(), end.getUTCHours(), end.getUTCMinutes(), end.getUTCSeconds(), end.getUTCMilliseconds())).toISOString());
      // De nouveau actif : plus de blocage des actions administratives.
      await http(app).post('/api/v1/iam/users').set(bearer(tenant.adminToken)).send({ fullName: 'Nouvel Agent', email: `ok@${tenant.slug}.test` }).expect(201);
    });

    it('deux exécutions concurrentes n’émettent qu’une facture (verrou de ligne + index unique)', async () => {
      const tenant = await newTenant('lc-race');
      const end = new Date(Date.now() + 40 * MS_PER_DAY);
      await makeActive(app, tenant.tenantId, end);

      await Promise.all([run(tenant, daysAfter(end, -5)), run(tenant, daysAfter(end, -5)), run(tenant, daysAfter(end, -5))]);

      expect(await invoicesOf(app, tenant)).toHaveLength(1);
    });
  });

  describe('résiliation programmée', () => {
    it('cancelAtPeriodEnd : pas de facture de renouvellement, résiliation à l’échéance puis expiration après 90 jours', async () => {
      const tenant = await newTenant('lc-cancel');
      const end = new Date(Date.now() + 40 * MS_PER_DAY);
      await makeActive(app, tenant.tenantId, end);

      const cancel = await http(app).post(`${SUBSCRIPTION}/cancel`).set(bearer(tenant.adminToken)).expect(200);
      expect(cancel.body.data.cancelAtPeriodEnd).toBe(true);
      expect((await run(tenant, daysAfter(end, -7))).invoicesIssued).toBe(0);

      await run(tenant, daysAfter(end, 0.01));
      const cancelled = await readSubscription(app, tenant.tenantId);
      expect(cancelled.status).toBe('cancelled');

      await run(tenant, daysAfter(cancelled.statusChangedAt, 89));
      expect((await readSubscription(app, tenant.tenantId)).status).toBe('cancelled');
      await run(tenant, daysAfter(cancelled.statusChangedAt, 90));
      expect((await readSubscription(app, tenant.tenantId)).status).toBe('expired');
    });

    it('permet de reprendre la résiliation avant l’échéance, refuse hors statut actif', async () => {
      const tenant = await newTenant('lc-resume');
      await http(app).post(`${SUBSCRIPTION}/cancel`).set(bearer(tenant.adminToken)).expect(409);
      await makeActive(app, tenant.tenantId, new Date(Date.now() + 20 * MS_PER_DAY));
      await http(app).post(`${SUBSCRIPTION}/cancel`).set(bearer(tenant.adminToken)).expect(200);

      const resumed = await http(app).post(`${SUBSCRIPTION}/resume`).set(bearer(tenant.adminToken)).expect(200);

      expect(resumed.body.data.cancelAtPeriodEnd).toBe(false);
    });
  });

  describe('machine à états et job planifié', () => {
    it('refuse les transitions interdites (409 invalid_transition) : un essai ne passe pas en grace', async () => {
      const tenant = await newTenant('lc-fsm');
      const state = app.get((await import('../../src/modules/subscriptions/services/subscription-state.service')).SubscriptionStateService);
      const sub = await readSubscription(app, tenant.tenantId);
      const error = await app
        .get(PlatformDb)
        .run((tx) => state.transition(tx, sub, 'grace', { actor: { type: 'system' }, reason: 'test', now: new Date() }))
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'invalid_transition', status: 409 });
    });

    it('scheduledRun exécute le cycle sans lever d’erreur (horloge injectée)', async () => {
      await expect(lifecycle.scheduledRun()).resolves.toBeUndefined();
    });

    it('un abonnement en erreur n’interrompt pas les autres et est compté', async () => {
      const ok = await newTenant('lc-iso-a');
      const broken = await newTenant('lc-iso-b');
      const end = new Date(Date.now() + 40 * MS_PER_DAY);
      await makeActive(app, ok.tenantId, end);
      await makeActive(app, broken.tenantId, end);
      // Établissement supprimé logiquement : l'émission de sa facture échoue (introuvable), sans bloquer l'autre.
      await app.get(PlatformDb).run((tx) => tx.tenant.update({ where: { id: broken.tenantId }, data: { deletedAt: new Date() } }));

      const report = await lifecycle.runLifecycle(daysAfter(end, -5), { tenantIds: [ok.tenantId, broken.tenantId] });

      expect(report).toMatchObject({ examined: 2, invoicesIssued: 1, errors: 1 });
      expect(await invoicesOf(app, ok)).toHaveLength(1);
    });
  });
});
