import type { INestApplication } from '@nestjs/common';
import { TRIAL_DAYS, type EstablishmentType } from '@ghmt/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlatformDb } from '../../src/infrastructure/prisma/platform-db.service';
import { TenantProvisioningService } from '../../src/infrastructure/tenancy/tenant-provisioning.service';
import { PasswordService } from '../../src/common/auth/password.service';
import { FIXTURE_PASSWORD, createTenantFixture, createUserWithRole, signupInput, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { bearer, http } from '../helpers/platform';
import { createTestApp } from '../helpers/test-app';
import { MS_PER_DAY, SUBSCRIPTION, readSubscription } from './subscription-fixtures';

describe('subscriptions : abonnement du tenant (GET /subscription)', () => {
  let app: INestApplication;
  let a: TenantFixture;
  let b: TenantFixture;
  let receptionist: UserFixture;

  beforeAll(async () => {
    app = await createTestApp();
    a = await createTenantFixture(app, { prefix: 'sub-a', subscriptionPlan: 'trial' });
    b = await createTenantFixture(app, { prefix: 'sub-b', subscriptionPlan: 'basic' });
    receptionist = await createUserWithRole(app, a, 'receptionist');
  });

  afterAll(async () => {
    await app?.close();
  });

  it('renvoie plan, statut, période, essai de 30 jours, droits et usage', async () => {
    const res = await http(app).get(SUBSCRIPTION).set(bearer(a.adminToken)).expect(200);

    const data = res.body.data;
    expect(data).toMatchObject({
      status: 'trial',
      billingPeriod: 'monthly',
      cancelAtPeriodEnd: false,
      pendingChange: null,
      plan: { code: 'standard', tier: 'standard', priceMonthly: '75000.00', currency: 'XOF' },
      usage: { users: 2, sites: 1, appointmentsThisMonth: 0 },
    });
    expect(data.entitlements.limits).toMatchObject({ users: 25, sites: 2, appointmentsMonthly: 3000 });
    expect(data.entitlements.modules).toEqual(expect.arrayContaining(['billing', 'cashier']));
    const days = (new Date(data.trialEndsAt).getTime() - new Date(data.currentPeriodStart).getTime()) / MS_PER_DAY;
    expect(days).toBe(TRIAL_DAYS);
    expect(data.currentPeriodEnd).toBe(data.trialEndsAt);
  });

  it('exige settings:establishment:read (403) et une authentification (401)', async () => {
    await http(app).get(SUBSCRIPTION).expect(401);
    const res = await http(app).get(SUBSCRIPTION).set(bearer(receptionist.token)).expect(403);
    expect(res.body.code).toBe('permission_denied');
  });

  it('cloisonne les établissements : chacun ne voit que son abonnement et son usage', async () => {
    const [ra, rb] = await Promise.all([
      http(app).get(SUBSCRIPTION).set(bearer(a.adminToken)).expect(200),
      http(app).get(SUBSCRIPTION).set(bearer(b.adminToken)).expect(200),
    ]);
    expect(ra.body.data.id).not.toBe(rb.body.data.id);
    expect(ra.body.data.plan.code).toBe('standard');
    expect(rb.body.data.plan.code).toBe('basic');
    expect(rb.body.data.usage.users).toBe(1);
    expect(rb.body.data.entitlements.limits.users).toBe(5);
  });

  it('liste les offres publiques (dernière version, prix croissants) pour le changement de plan', async () => {
    const res = await http(app).get(`${SUBSCRIPTION}/plans`).set(bearer(a.adminToken)).expect(200);
    const codes = (res.body.data as { code: string }[]).map((p) => p.code);
    expect(codes.slice(0, 4)).toEqual(['basic', 'standard', 'professional', 'enterprise']);
    expect(res.body.data[0].entitlements.limits.users).toBe(5);
    await http(app).get(`${SUBSCRIPTION}/plans`).set(bearer(receptionist.token)).expect(403);
  });

  describe('essai à l’inscription selon le type d’établissement (plafonné à Standard)', () => {
    const cases: readonly (readonly [EstablishmentType, string])[] = [
      ['private_practice', 'basic'],
      ['pharmacy', 'basic'],
      ['laboratory', 'basic'],
      ['clinic', 'standard'],
      ['health_center', 'standard'],
      ['hospital_n3', 'standard'],
      ['diagnostic_center', 'standard'],
    ];
    it.each(cases)('%s ⇒ essai %s, 30 jours, statut trial', async (type, expectedPlan) => {
      const slug = `type-${type.replace(/_/g, '-')}-${Math.random().toString(36).slice(2, 8)}`;
      const hash = await app.get(PasswordService).hash(FIXTURE_PASSWORD);
      const { tenantId } = await app.get(TenantProvisioningService).provision(signupInput(slug, { establishmentType: type }), hash);

      const row = await readSubscription(app, tenantId);
      const plan = await app.get(PlatformDb).run((tx) => tx.plan.findUniqueOrThrow({ where: { id: row.planId } }));
      expect(plan.code).toBe(expectedPlan);
      expect(row.status).toBe('trial');
      expect(Math.round((row.trialEndsAt!.getTime() - row.currentPeriodStart.getTime()) / MS_PER_DAY)).toBe(TRIAL_DAYS);
      const modules = await app.get(PlatformDb).run((tx) => tx.tenantModule.findMany({ where: { tenantId, disabledAt: null } }));
      expect(modules.map((m) => m.moduleCode)).toEqual(expect.arrayContaining(['billing', 'cashier']));
    });
  });

  it('crée l’abonnement dans la transaction d’inscription (un seul par établissement)', async () => {
    const count = await app.get(PlatformDb).run((tx) => tx.subscription.count({ where: { tenantId: a.tenantId } }));
    expect(count).toBe(1);
  });
});
