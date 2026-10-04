import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlatformDb } from '../../src/infrastructure/prisma/platform-db.service';
import { SubscriptionLifecycleService } from '../../src/modules/subscriptions/services/subscription-lifecycle.service';
import { createTenantFixture, createUserWithRole, type TenantFixture } from '../helpers/fixtures';
import { bearer, http } from '../helpers/platform';
import { createTestApp } from '../helpers/test-app';
import { MS_PER_DAY, SUBSCRIPTION, createDoubles, invoicesOf, makeActive, publishPaymentSucceeded, readSubscription, tenantStatusOf } from './subscription-fixtures';

describe('subscriptions : changement de plan (POST /subscription/change)', () => {
  const doubles = createDoubles();
  let app: INestApplication;

  const change = (tenant: Pick<TenantFixture, 'adminToken'>, body: Record<string, unknown>) =>
    http(app).post(`${SUBSCRIPTION}/change`).set(bearer(tenant.adminToken)).send(body);
  const planOf = async (tenantId: string): Promise<string> => {
    const sub = await readSubscription(app, tenantId);
    return (await app.get(PlatformDb).run((tx) => tx.plan.findUniqueOrThrow({ where: { id: sub.planId } }))).code;
  };
  const enabledModules = async (tenantId: string): Promise<string[]> =>
    (await app.get(PlatformDb).run((tx) => tx.tenantModule.findMany({ where: { tenantId, disabledAt: null } }))).map((m) => m.moduleCode);

  /** Établissement actif sur un plan donné, à mi-période (15 jours écoulés sur 30). */
  async function activeTenant(prefix: string, planCode: string): Promise<TenantFixture> {
    const tenant = await createTenantFixture(app, { prefix, subscriptionPlan: planCode });
    const end = new Date(Date.now() + 15 * MS_PER_DAY);
    await makeActive(app, tenant.tenantId, end);
    return tenant;
  }

  beforeAll(async () => {
    app = await createTestApp({}, { providerOverrides: doubles.overrides });
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('montée en gamme', () => {
    it('applique le plan immédiatement avec une facture de prorata (TVA du pays) et relève droits et modules', async () => {
      const tenant = await activeTenant('chg-up', 'basic');

      const res = await change(tenant, { planCode: 'standard', billingPeriod: 'monthly' }).expect(200);

      expect(res.body.data.effect).toBe('immediate');
      expect(res.body.data.subscription).toMatchObject({ plan: { code: 'standard' }, status: 'active', pendingChange: null });
      expect(res.body.data.subscription.entitlements.limits.users).toBe(25);
      const invoice = res.body.data.invoice;
      expect(invoice).toMatchObject({ kind: 'upgrade_prorata', status: 'open', taxRate: '0.1800' });
      // (75 000 − 25 000) × ~15/30 = ~25 000 ; TVA 18 % ; total = sous-total + taxe, calculé sans flottant.
      expect(Number(invoice.subtotal)).toBeGreaterThan(24_900);
      expect(Number(invoice.subtotal)).toBeLessThan(25_100);
      expect(Math.round(Number(invoice.total) * 100)).toBe(Math.round(Number(invoice.subtotal) * 100) + Math.round(Number(invoice.taxAmount) * 100));
      expect(invoice.lines[0].description).toContain('Basic → Standard');
      expect(await planOf(tenant.tenantId)).toBe('standard');
      expect(await enabledModules(tenant.tenantId)).toEqual(expect.arrayContaining(['laboratory', 'pharmacy', 'billing', 'cashier']));
    });

    it('le paiement du prorata ne décale pas la période de l’abonnement', async () => {
      const tenant = await activeTenant('chg-prorata', 'basic');
      const res = await change(tenant, { planCode: 'professional', billingPeriod: 'monthly' }).expect(200);
      const before = await readSubscription(app, tenant.tenantId);

      await publishPaymentSucceeded(app, tenant, res.body.data.invoice);

      const after = await readSubscription(app, tenant.tenantId);
      expect(after.currentPeriodEnd.toISOString()).toBe(before.currentPeriodEnd.toISOString());
      expect((await invoicesOf(app, tenant)).find((i) => i.kind === 'upgrade_prorata')?.status).toBe('paid');
    });

    it('en essai : le plan change tout de suite et la facture de conversion est émise', async () => {
      const tenant = await createTenantFixture(app, { prefix: 'chg-trial', subscriptionPlan: 'trial' });
      const res = await change(tenant, { planCode: 'professional', billingPeriod: 'yearly' }).expect(200);
      expect(res.body.data).toMatchObject({ effect: 'immediate', invoice: { kind: 'conversion', subtotal: '2000000.00' } });
      expect(await planOf(tenant.tenantId)).toBe('professional');
    });
  });

  describe('descente en gamme', () => {
    it('planifie le changement en fin de période : plan inchangé, changement annoncé, facture suivante au nouveau tarif', async () => {
      const tenant = await activeTenant('chg-down', 'standard');
      const sub = await readSubscription(app, tenant.tenantId);

      const res = await change(tenant, { planCode: 'basic', billingPeriod: 'monthly' }).expect(200);

      expect(res.body.data.effect).toBe('scheduled');
      expect(res.body.data.invoice).toBeNull();
      expect(res.body.data.subscription).toMatchObject({
        plan: { code: 'standard' },
        pendingChange: { planCode: 'basic', billingPeriod: 'monthly', effectiveAt: sub.currentPeriodEnd.toISOString() },
      });

      // Facture de renouvellement au tarif Basic ; le paiement applique le plan planifié.
      await app.get(SubscriptionLifecycleService).runLifecycle(new Date(sub.currentPeriodEnd.getTime() - 5 * MS_PER_DAY), { tenantIds: [tenant.tenantId] });
      const renewal = (await invoicesOf(app, tenant)).find((i) => i.kind === 'renewal')!;
      expect(renewal.subtotal).toBe('25000.00');
      await publishPaymentSucceeded(app, tenant, renewal);
      expect(await planOf(tenant.tenantId)).toBe('basic');
      const after = await readSubscription(app, tenant.tenantId);
      expect(after.pendingPlanId).toBeNull();
      expect(await enabledModules(tenant.tenantId)).not.toContain('laboratory');
    });

    it('refuse un downgrade incompatible avec l’usage (409 downgrade_incompatible) et liste les dépassements', async () => {
      const tenant = await activeTenant('chg-incompat', 'standard');
      // L'administrateur + 5 réceptionnistes = 6 utilisateurs (> 5 pour Basic).
      for (let i = 0; i < 5; i += 1) await createUserWithRole(app, tenant, 'receptionist');

      const res = await change(tenant, { planCode: 'basic', billingPeriod: 'monthly' }).expect(409);

      expect(res.body.code).toBe('downgrade_incompatible');
      expect(res.body.details.violations).toEqual([{ metric: 'users', limit: 5, current: 6 }]);
      expect((await readSubscription(app, tenant.tenantId)).pendingPlanId).toBeNull();
    });

    it('signale aussi les sites en trop', async () => {
      const tenant = await activeTenant('chg-sites', 'standard');
      await http(app).post('/api/v1/org/sites').set(bearer(tenant.adminToken)).send({ code: 'S2', name: 'Second site' }).expect(201);
      const res = await change(tenant, { planCode: 'basic', billingPeriod: 'monthly' }).expect(409);
      expect(res.body.details.violations).toEqual([{ metric: 'sites', limit: 1, current: 2 }]);
    });

    it('un changement de périodicité seul est planifié à l’échéance', async () => {
      const tenant = await activeTenant('chg-period', 'standard');
      const res = await change(tenant, { planCode: 'standard', billingPeriod: 'yearly' }).expect(200);
      expect(res.body.data.effect).toBe('scheduled');
      expect(res.body.data.subscription).toMatchObject({ billingPeriod: 'monthly', pendingChange: { planCode: 'standard', billingPeriod: 'yearly' } });
    });
  });

  describe('réactivation après suspension ou expiration', () => {
    it('reste possible quand l’établissement est en lecture seule : facture émise, plan appliqué au paiement', async () => {
      const tenant = await createTenantFixture(app, { prefix: 'chg-react', subscriptionPlan: 'trial' });
      await app.get(SubscriptionLifecycleService).runLifecycle(new Date(Date.now() + 31 * MS_PER_DAY), { tenantIds: [tenant.tenantId] });
      expect((await readSubscription(app, tenant.tenantId)).status).toBe('expired');
      expect(await tenantStatusOf(app, tenant.tenantId)).toBe('suspended');

      const res = await change(tenant, { planCode: 'basic', billingPeriod: 'monthly' }).expect(200);

      expect(res.body.data.effect).toBe('pending_payment');
      expect(res.body.data.invoice).toMatchObject({ kind: 'conversion', subtotal: '25000.00' });
      expect(res.body.data.subscription.status).toBe('expired');
      await http(app).post(`${SUBSCRIPTION}/invoices/${res.body.data.invoice.id}/pay`).set(bearer(tenant.adminToken)).send({ payerPhone: '+221771234567' }).expect(200);

      await publishPaymentSucceeded(app, tenant, res.body.data.invoice);

      expect((await readSubscription(app, tenant.tenantId)).status).toBe('active');
      expect(await planOf(tenant.tenantId)).toBe('basic');
      expect(await tenantStatusOf(app, tenant.tenantId)).toBe('active');
    });
  });

  describe('refus', () => {
    it('409 no_change si le plan et la périodicité sont inchangés', async () => {
      const tenant = await activeTenant('chg-same', 'standard');
      const res = await change(tenant, { planCode: 'standard', billingPeriod: 'monthly' }).expect(409);
      expect(res.body.code).toBe('no_change');
    });

    it('404 pour un plan inconnu ou non public, 422 pour une entrée invalide', async () => {
      const tenant = await activeTenant('chg-bad', 'standard');
      await change(tenant, { planCode: 'inexistant', billingPeriod: 'monthly' }).expect(404);
      await app.get(PlatformDb).run((tx) => tx.plan.create({ data: { code: 'prive_test', name: 'Privé', tier: 'standard', priceMonthly: '1.00', priceYearly: '10.00', currency: 'XOF', isPublic: false, entitlements: { modules: ['billing', 'cashier'], limits: { users: 1, sites: 1, appointmentsMonthly: 1, activePatients: 1, smsMonthly: 1, storageGb: 1 }, features: { customRoles: false, export: false, api: false } } } })).catch(() => undefined);
      await change(tenant, { planCode: 'prive_test', billingPeriod: 'monthly' }).expect(404);
      await change(tenant, { planCode: 'Basic', billingPeriod: 'monthly' }).expect(422);
      await change(tenant, { planCode: 'basic', billingPeriod: 'daily' }).expect(422);
      await change(tenant, {}).expect(422);
    });

    it('403 sans settings:establishment:update, 401 sans jeton', async () => {
      const tenant = await activeTenant('chg-perm', 'standard');
      const reception = await createUserWithRole(app, tenant, 'receptionist');
      await http(app).post(`${SUBSCRIPTION}/change`).set(bearer(reception.token)).send({ planCode: 'basic', billingPeriod: 'monthly' }).expect(403);
      await http(app).post(`${SUBSCRIPTION}/change`).send({ planCode: 'basic', billingPeriod: 'monthly' }).expect(401);
    });

    it('le tenant vient du jeton : un autre tenant ne peut pas être ciblé par le corps', async () => {
      const mine = await activeTenant('chg-iso-a', 'standard');
      const other = await activeTenant('chg-iso-b', 'standard');
      await change(mine, { planCode: 'professional', billingPeriod: 'monthly', tenantId: other.tenantId }).expect(200);
      expect(await planOf(other.tenantId)).toBe('standard');
      expect(await planOf(mine.tenantId)).toBe('professional');
    });
  });
});
