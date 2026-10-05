import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlatformDb } from '../../src/infrastructure/prisma/platform-db.service';
import { createTenantFixture, type TenantFixture } from '../helpers/fixtures';
import { bearer, http, platformClientIp } from '../helpers/platform';
import { createTestApp } from '../helpers/test-app';
import { MS_PER_DAY, SUBSCRIPTION, createDoubles, invoicesOf, makeActive, publishPaymentSucceeded, readSubscription } from './subscription-fixtures';

describe('subscriptions : montée en gamme payée avant application (H3) et essai restreint', () => {
  const doubles = createDoubles();
  let app: INestApplication;

  const change = (tenant: Pick<TenantFixture, 'adminToken'>, body: Record<string, unknown>) =>
    http(app).post(`${SUBSCRIPTION}/change`).set('X-Forwarded-For', platformClientIp()).set(bearer(tenant.adminToken)).send(body);
  const planOf = async (tenantId: string): Promise<string> => {
    const sub = await readSubscription(app, tenantId);
    return (await app.get(PlatformDb).run((tx) => tx.plan.findUniqueOrThrow({ where: { id: sub.planId } }))).code;
  };
  const enabledModules = async (tenantId: string): Promise<string[]> =>
    (await app.get(PlatformDb).run((tx) => tx.tenantModule.findMany({ where: { tenantId, disabledAt: null } }))).map((m) => m.moduleCode);

  async function activeTenant(prefix: string, planCode: string): Promise<TenantFixture> {
    const tenant = await createTenantFixture(app, { prefix, subscriptionPlan: planCode });
    await makeActive(app, tenant.tenantId, new Date(Date.now() + 15 * MS_PER_DAY));
    return tenant;
  }

  beforeAll(async () => {
    app = await createTestApp({}, { providerOverrides: doubles.overrides });
  });
  afterAll(async () => {
    await app?.close();
  });

  describe('upgrade', () => {
    it('n’applique PAS le nouveau plan avant le paiement du prorata (effet pending_payment, droits et modules inchangés)', async () => {
      const tenant = await activeTenant('up-pend', 'basic');

      const res = await change(tenant, { planCode: 'standard', billingPeriod: 'monthly' }).expect(200);

      expect(res.body.data.effect).toBe('pending_payment');
      expect(res.body.data.invoice).toMatchObject({ kind: 'upgrade_prorata', status: 'open' });
      expect(res.body.data.subscription).toMatchObject({ plan: { code: 'basic' }, pendingChange: { planCode: 'standard' } });
      expect(res.body.data.subscription.entitlements.limits.users).toBe(5);
      expect(await planOf(tenant.tenantId)).toBe('basic');
      expect(await enabledModules(tenant.tenantId)).not.toContain('laboratory');
    });

    it('applique le plan, les droits et les modules au règlement de la facture de prorata', async () => {
      const tenant = await activeTenant('up-paid', 'basic');
      const res = await change(tenant, { planCode: 'standard', billingPeriod: 'monthly' }).expect(200);
      const before = await readSubscription(app, tenant.tenantId);

      await publishPaymentSucceeded(app, tenant, res.body.data.invoice);

      const after = await readSubscription(app, tenant.tenantId);
      expect(await planOf(tenant.tenantId)).toBe('standard');
      expect(after.pendingPlanId).toBeNull();
      expect(after.currentPeriodEnd.toISOString()).toBe(before.currentPeriodEnd.toISOString());
      expect(await enabledModules(tenant.tenantId)).toEqual(expect.arrayContaining(['laboratory', 'pharmacy']));
      const view = await http(app).get(SUBSCRIPTION).set(bearer(tenant.adminToken)).expect(200);
      expect(view.body.data).toMatchObject({ plan: { code: 'standard' }, pendingChange: null });
      expect(view.body.data.entitlements.limits.users).toBe(25);
    });

    it('un second upgrade annule la facture de prorata précédente et ne retient que la dernière demande', async () => {
      const tenant = await activeTenant('up-twice', 'basic');
      const first = await change(tenant, { planCode: 'standard', billingPeriod: 'monthly' }).expect(200);

      const second = await change(tenant, { planCode: 'professional', billingPeriod: 'monthly' }).expect(200);

      const invoices = await invoicesOf(app, tenant);
      expect(invoices.find((i) => i.id === first.body.data.invoice.id)?.status).toBe('void');
      expect(invoices.find((i) => i.id === second.body.data.invoice.id)?.status).toBe('open');
      await publishPaymentSucceeded(app, tenant, second.body.data.invoice);
      expect(await planOf(tenant.tenantId)).toBe('professional');
    });

    it('un prorata périmé (annulé) réglé ensuite n’applique aucun plan', async () => {
      const tenant = await activeTenant('up-stale', 'basic');
      const first = await change(tenant, { planCode: 'standard', billingPeriod: 'monthly' }).expect(200);
      await change(tenant, { planCode: 'professional', billingPeriod: 'monthly' }).expect(200);

      await publishPaymentSucceeded(app, tenant, first.body.data.invoice);

      expect(await planOf(tenant.tenantId)).toBe('basic');
    });
  });

  describe('essai : seules les offres basic et standard sont sélectionnables', () => {
    it('refuse professional pendant l’essai (409 plan_not_allowed_in_trial) et accepte standard', async () => {
      const tenant = await createTenantFixture(app, { prefix: 'tr-sel', subscriptionPlan: 'trial' });

      const refused = await change(tenant, { planCode: 'professional', billingPeriod: 'monthly' }).expect(409);
      const accepted = await change(tenant, { planCode: 'standard', billingPeriod: 'monthly' }).expect(200);

      expect(refused.body.code).toBe('plan_not_allowed_in_trial');
      expect(accepted.body.data).toMatchObject({ effect: 'immediate', invoice: { kind: 'conversion' } });
      expect(await planOf(tenant.tenantId)).toBe('standard');
    });

    it('GET /subscription/plans indique selectable : faux pour professional/enterprise en essai, vrai ensuite', async () => {
      const trial = await createTenantFixture(app, { prefix: 'tr-list', subscriptionPlan: 'trial' });
      const active = await activeTenant('tr-list-a', 'standard');

      const inTrial = await http(app).get(`${SUBSCRIPTION}/plans`).set(bearer(trial.adminToken)).expect(200);
      const whenActive = await http(app).get(`${SUBSCRIPTION}/plans`).set(bearer(active.adminToken)).expect(200);

      const flags = (body: { data: { code: string; selectable: boolean }[] }) => Object.fromEntries(body.data.map((p) => [p.code, p.selectable]));
      expect(flags(inTrial.body)).toMatchObject({ basic: true, standard: true, professional: false, enterprise: false });
      expect(flags(whenActive.body)).toMatchObject({ basic: true, standard: true, professional: true, enterprise: true });
    });
  });
});
