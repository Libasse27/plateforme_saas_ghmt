import type { INestApplication } from '@nestjs/common';
import { DEFAULT_PLAN_CATALOG } from '@ghmt/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlatformDb } from '../../src/infrastructure/prisma/platform-db.service';
import { SubscriptionLifecycleService } from '../../src/modules/subscriptions/services/subscription-lifecycle.service';
import { openConversionInvoice, publishPaymentSucceeded } from '../subscriptions/subscription-fixtures';
import { createTenantFixture, createUserWithRole, type TenantFixture } from '../helpers/fixtures';
import { PLATFORM, bearer, createPlatformUser, http, type PlatformUserFixture } from '../helpers/platform';
import { createTestApp } from '../helpers/test-app';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe('platform : console (tenants, plans, abonnements, tableau de bord)', () => {
  let app: INestApplication;
  let admin: PlatformUserFixture;
  let support: PlatformUserFixture;
  let billing: PlatformUserFixture;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;

  beforeAll(async () => {
    app = await createTestApp();
    [admin, support, billing] = await Promise.all([
      createPlatformUser(app, 'super_admin'),
      createPlatformUser(app, 'support'),
      createPlatformUser(app, 'billing'),
    ]);
    [tenantA, tenantB] = await Promise.all([
      createTenantFixture(app, { prefix: 'cons-a', subscriptionPlan: 'trial' }),
      createTenantFixture(app, { prefix: 'cons-b', subscriptionPlan: 'trial' }),
    ]);
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('matrice des rôles', () => {
    it('support : lit tenants, plans, abonnements, tableau de bord ; ne suspend ni ne modifie rien', async () => {
      await http(app).get(`${PLATFORM}/tenants`).set(bearer(support.token)).expect(200);
      await http(app).get(`${PLATFORM}/plans`).set(bearer(support.token)).expect(200);
      await http(app).get(`${PLATFORM}/subscriptions/${tenantA.tenantId}`).set(bearer(support.token)).expect(200);
      await http(app).get(`${PLATFORM}/dashboard`).set(bearer(support.token)).expect(200);

      await http(app).get(`${PLATFORM}/invoices`).set(bearer(support.token)).expect(403);
      await http(app).get(`${PLATFORM}/dashboard/audit-logs`).set(bearer(support.token)).expect(403);
      await http(app).post(`${PLATFORM}/tenants/${tenantA.tenantId}/suspend`).set(bearer(support.token)).send({ reason: 'Impayé constaté' }).expect(403);
      await http(app).post(`${PLATFORM}/subscriptions/${tenantA.tenantId}/extend-trial`).set(bearer(support.token)).expect(403);
      await http(app).post(`${PLATFORM}/plans`).set(bearer(support.token)).send({}).expect(403);
    });

    it('billing : gère plans, abonnements et factures ; ne suspend pas un établissement ni ne lit l’audit', async () => {
      await http(app).get(`${PLATFORM}/invoices`).set(bearer(billing.token)).expect(200);
      await http(app).post(`${PLATFORM}/tenants/${tenantA.tenantId}/suspend`).set(bearer(billing.token)).send({ reason: 'Impayé constaté' }).expect(403);
      await http(app).get(`${PLATFORM}/dashboard/audit-logs`).set(bearer(billing.token)).expect(403);
    });
  });

  describe('établissements', () => {
    it('liste paginée avec filtre texte, statut et abonnement', async () => {
      const res = await http(app).get(`${PLATFORM}/tenants`).query({ q: tenantA.slug }).set(bearer(admin.token)).expect(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({
        id: tenantA.tenantId,
        slug: tenantA.slug,
        status: 'active',
        subscription: { status: 'trial', planCode: 'standard' },
      });

      const page1 = await http(app).get(`${PLATFORM}/tenants`).query({ limit: 1, subscriptionStatus: 'trial' }).set(bearer(admin.token)).expect(200);
      expect(page1.body.data).toHaveLength(1);
      expect(page1.body.meta.pagination).toMatchObject({ limit: 1, hasMore: true });
      const page2 = await http(app)
        .get(`${PLATFORM}/tenants`)
        .query({ limit: 1, subscriptionStatus: 'trial', cursor: page1.body.meta.pagination.nextCursor })
        .set(bearer(admin.token))
        .expect(200);
      expect(page2.body.data[0].id).not.toBe(page1.body.data[0].id);

      await http(app).get(`${PLATFORM}/tenants`).query({ status: 'inconnu' }).set(bearer(admin.token)).expect(422);
      await http(app).get(`${PLATFORM}/tenants`).query({ cursor: 'pas-un-curseur' }).set(bearer(admin.token)).expect(422);
    });

    it('détail : usage agrégé en comptes, modules et factures, sans donnée patient', async () => {
      await createUserWithRole(app, tenantA, 'receptionist');

      const res = await http(app).get(`${PLATFORM}/tenants/${tenantA.tenantId}`).set(bearer(admin.token)).expect(200);

      expect(res.body.data.tenant).toMatchObject({ id: tenantA.tenantId, baseCurrency: 'XOF', countryCode: 'SN', suspensionReason: null });
      expect(res.body.data.usage).toEqual({ users: 2, sites: 1, patients: 0, appointmentsThisMonth: 0, appointmentsLast30Days: 0 });
      expect(res.body.data.modules).toEqual(expect.arrayContaining(['appointments', 'billing', 'cashier']));
      expect(res.body.data.subscription).toMatchObject({ status: 'trial', tenantId: tenantA.tenantId });
      expect(res.body.data.invoices).toEqual({ open: 0, overdue: 0 });
      expect(JSON.stringify(res.body.data)).not.toMatch(/lastName|firstName|birthDate|ipp/);
    });

    it('404 pour un établissement inconnu ou un identifiant mal formé', async () => {
      await http(app).get(`${PLATFORM}/tenants/0198a000-0000-7000-8000-0000000000ff`).set(bearer(admin.token)).expect(404);
      await http(app).get(`${PLATFORM}/tenants/pas-un-uuid`).set(bearer(admin.token)).expect(404);
    });

    it('suspend avec motif : le tenant passe en lecture seule (continuité des soins), puis se réactive', async () => {
      const reception = await createUserWithRole(app, tenantB, 'receptionist');
      const tooShort = await http(app).post(`${PLATFORM}/tenants/${tenantB.tenantId}/suspend`).set(bearer(admin.token)).send({ reason: 'x' }).expect(422);
      expect(tooShort.body.code).toBe('validation_failed');

      const res = await http(app)
        .post(`${PLATFORM}/tenants/${tenantB.tenantId}/suspend`)
        .set(bearer(admin.token))
        .send({ reason: 'Fraude suspectée sur le compte' })
        .expect(200);
      expect(res.body.data.tenant).toMatchObject({ status: 'suspended', suspensionReason: 'Fraude suspectée sur le compte' });

      // Lecture autorisée, écriture administrative refusée, création de patient autorisée (continuité des soins).
      await http(app).get('/api/v1/org/sites').set(bearer(tenantB.adminToken)).expect(200);
      const write = await http(app).post('/api/v1/org/sites').set(bearer(tenantB.adminToken)).send({ code: 'NOUV', name: 'Nouveau' }).expect(403);
      expect(write.body.code).toBe('subscription_suspended');
      await http(app)
        .post('/api/v1/patients')
        .set(bearer(reception.token))
        .send({ lastName: 'Urgence', firstName: 'Patient', sex: 'female', birthDate: '1990-01-01' })
        .expect((r) => expect(r.status).not.toBe(403));

      await http(app).post(`${PLATFORM}/tenants/${tenantB.tenantId}/suspend`).set(bearer(admin.token)).send({ reason: 'Deuxième suspension' }).expect(409);

      const back = await http(app).post(`${PLATFORM}/tenants/${tenantB.tenantId}/reactivate`).set(bearer(admin.token)).expect(200);
      expect(back.body.data.tenant).toMatchObject({ status: 'active', suspensionReason: null });
      await http(app).post('/api/v1/org/sites').set(bearer(tenantB.adminToken)).send({ code: 'NOUV', name: 'Nouveau' }).expect(201);

      const again = await http(app).post(`${PLATFORM}/tenants/${tenantB.tenantId}/reactivate`).set(bearer(admin.token)).expect(409);
      expect(again.body.code).toBe('not_manually_suspended');

      const audit = await app.get(PlatformDb).run((tx) => tx.platformAuditLog.findMany({ where: { tenantId: tenantB.tenantId, action: { in: ['tenant.suspended', 'tenant.reactivated'] } } }));
      expect(audit.map((a) => a.action).sort()).toEqual(['tenant.reactivated', 'tenant.suspended']);
      expect(audit.every((a) => a.actorUserId === admin.userId && a.actorRole === 'super_admin')).toBe(true);
    });

    it('la suspension manuelle survit au paiement : l’abonnement redevient actif mais seule la plateforme lève le blocage', async () => {
      const tenant = await createTenantFixture(app, { prefix: 'cons-man', subscriptionPlan: 'trial' });
      await app.get(SubscriptionLifecycleService).runLifecycle(new Date(Date.now() + 31 * MS_PER_DAY), { tenantIds: [tenant.tenantId] });
      await http(app).post(`${PLATFORM}/tenants/${tenant.tenantId}/suspend`).set(bearer(admin.token)).send({ reason: 'Litige commercial en cours' }).expect(200);
      const invoice = await openConversionInvoice(app, tenant);

      await publishPaymentSucceeded(app, tenant, invoice);

      const detail = await http(app).get(`${PLATFORM}/tenants/${tenant.tenantId}`).set(bearer(admin.token)).expect(200);
      expect(detail.body.data.subscription.status).toBe('active');
      expect(detail.body.data.tenant).toMatchObject({ status: 'suspended', suspensionReason: 'Litige commercial en cours' });
      await http(app).post('/api/v1/org/sites').set(bearer(tenant.adminToken)).send({ code: 'BLQ', name: 'Bloqué' }).expect(403);

      await http(app).post(`${PLATFORM}/tenants/${tenant.tenantId}/reactivate`).set(bearer(admin.token)).expect(200);
      await http(app).post('/api/v1/org/sites').set(bearer(tenant.adminToken)).send({ code: 'BLQ', name: 'Débloqué' }).expect(201);
    });

    it('la réactivation laisse l’établissement en lecture seule tant que l’abonnement est suspendu ou expiré', async () => {
      const tenant = await createTenantFixture(app, { prefix: 'cons-ro', subscriptionPlan: 'trial' });
      await http(app).post(`${PLATFORM}/tenants/${tenant.tenantId}/suspend`).set(bearer(admin.token)).send({ reason: 'Contrôle de conformité' }).expect(200);
      await app.get(SubscriptionLifecycleService).runLifecycle(new Date(Date.now() + 31 * MS_PER_DAY), { tenantIds: [tenant.tenantId] });

      const res = await http(app).post(`${PLATFORM}/tenants/${tenant.tenantId}/reactivate`).set(bearer(admin.token)).expect(200);

      expect(res.body.data.tenant.status).toBe('suspended');
      expect(res.body.data.subscription.status).toBe('expired');
    });
  });

  describe('plans', () => {
    const newPlan = (overrides: Record<string, unknown> = {}) => {
      const basic = DEFAULT_PLAN_CATALOG[0]!;
      return {
        code: `test_${Math.random().toString(36).slice(2, 8)}`,
        name: 'Plan de test',
        tier: 'standard',
        priceMonthly: '10000.00',
        priceYearly: '100000.00',
        currency: 'XOF',
        entitlements: basic.entitlements,
        isPublic: false,
        ...overrides,
      };
    };

    it('liste le catalogue de départ (4 plans, tarifs XOF, billing et cashier partout)', async () => {
      const res = await http(app).get(`${PLATFORM}/plans`).set(bearer(admin.token)).expect(200);
      const codes = (res.body.data as { code: string }[]).map((p) => p.code);
      expect(codes).toEqual(expect.arrayContaining(['basic', 'standard', 'professional', 'enterprise']));
      for (const plan of res.body.data as { code: string; entitlements: { modules: string[] } }[]) {
        if (['basic', 'standard', 'professional', 'enterprise'].includes(plan.code)) {
          expect(plan.entitlements.modules).toEqual(expect.arrayContaining(['billing', 'cashier']));
        }
      }
      const basic = (res.body.data as { code: string; priceMonthly: string }[]).find((p) => p.code === 'basic');
      expect(basic?.priceMonthly).toBe('25000.00');
    });

    it('crée une nouvelle version (v1 puis v2) et archive la précédente ; l’ancienne reste lisible', async () => {
      const body = newPlan();
      const v1 = await http(app).post(`${PLATFORM}/plans`).set(bearer(admin.token)).send(body).expect(201);
      expect(v1.body.data).toMatchObject({ code: body.code, version: 1, archivedAt: null });
      const v2 = await http(app).post(`${PLATFORM}/plans`).set(bearer(billing.token)).send({ ...body, priceMonthly: '12000.00' }).expect(201);
      expect(v2.body.data).toMatchObject({ version: 2, priceMonthly: '12000.00' });

      const active = await http(app).get(`${PLATFORM}/plans`).set(bearer(admin.token)).expect(200);
      expect((active.body.data as { code: string; version: number }[]).filter((p) => p.code === body.code).map((p) => p.version)).toEqual([2]);
      const all = await http(app).get(`${PLATFORM}/plans`).query({ includeArchived: 'true' }).set(bearer(admin.token)).expect(200);
      expect((all.body.data as { code: string; version: number }[]).filter((p) => p.code === body.code).map((p) => p.version)).toEqual([2, 1]);
    });

    it('refuse un plan sans billing/cashier, avec un module inconnu, un prix invalide ou un code mal formé (422)', async () => {
      const base = DEFAULT_PLAN_CATALOG[0]!.entitlements;
      const noBilling = await http(app)
        .post(`${PLATFORM}/plans`)
        .set(bearer(admin.token))
        .send(newPlan({ entitlements: { ...base, modules: ['appointments'] } }))
        .expect(422);
      expect(noBilling.body.errors[0].code).toBe('required_modules');
      const unknown = await http(app)
        .post(`${PLATFORM}/plans`)
        .set(bearer(admin.token))
        .send(newPlan({ entitlements: { ...base, modules: ['billing', 'cashier', 'telepathie'] } }))
        .expect(422);
      expect(unknown.body.errors[0].code).toBe('unknown_module');
      await http(app).post(`${PLATFORM}/plans`).set(bearer(admin.token)).send(newPlan({ priceMonthly: '-5' })).expect(422);
      await http(app).post(`${PLATFORM}/plans`).set(bearer(admin.token)).send(newPlan({ priceMonthly: '12.345' })).expect(422);
      await http(app).post(`${PLATFORM}/plans`).set(bearer(admin.token)).send(newPlan({ code: 'Code Invalide' })).expect(422);
    });

    it('serialise les créations concurrentes d’un même code (versions distinctes ou 409, jamais de doublon)', async () => {
      const body = newPlan();
      const results = await Promise.all(
        Array.from({ length: 4 }, () => http(app).post(`${PLATFORM}/plans`).set(bearer(admin.token)).send(body)),
      );
      expect(results.every((r) => [201, 409].includes(r.status))).toBe(true);
      const versions = await app.get(PlatformDb).run((tx) => tx.plan.findMany({ where: { code: body.code }, select: { version: true } }));
      expect(new Set(versions.map((v) => v.version)).size).toBe(versions.length);
    });
  });

  describe('abonnements', () => {
    it('affiche l’abonnement : plan d’essai, droits effectifs et usage', async () => {
      const res = await http(app).get(`${PLATFORM}/subscriptions/${tenantA.tenantId}`).set(bearer(admin.token)).expect(200);
      expect(res.body.data).toMatchObject({
        tenantId: tenantA.tenantId,
        status: 'trial',
        trialExtended: false,
        plan: { code: 'standard', version: 1 },
        usage: { users: 2, sites: 1 },
      });
      expect(res.body.data.entitlements.limits.users).toBe(25);
      await http(app).get(`${PLATFORM}/subscriptions/0198a000-0000-7000-8000-0000000000ff`).set(bearer(admin.token)).expect(404);
    });

    it('prolonge l’essai une seule fois de 15 jours', async () => {
      const tenant = await createTenantFixture(app, { prefix: 'cons-ext', subscriptionPlan: 'trial' });
      const before = await http(app).get(`${PLATFORM}/subscriptions/${tenant.tenantId}`).set(bearer(admin.token)).expect(200);

      const res = await http(app).post(`${PLATFORM}/subscriptions/${tenant.tenantId}/extend-trial`).set(bearer(admin.token)).expect(200);

      const delta = new Date(res.body.data.trialEndsAt).getTime() - new Date(before.body.data.trialEndsAt).getTime();
      expect(delta).toBe(15 * MS_PER_DAY);
      expect(res.body.data).toMatchObject({ trialExtended: true });
      expect(res.body.data.currentPeriodEnd).toBe(res.body.data.trialEndsAt);
      const second = await http(app).post(`${PLATFORM}/subscriptions/${tenant.tenantId}/extend-trial`).set(bearer(admin.token)).expect(409);
      expect(second.body.code).toBe('trial_already_extended');
    });

    it('change le plan avec dérogations : droits effectifs relevés et modules synchronisés', async () => {
      const tenant = await createTenantFixture(app, { prefix: 'cons-chg', subscriptionPlan: 'trial' });

      const res = await http(app)
        .post(`${PLATFORM}/subscriptions/${tenant.tenantId}/change`)
        .set(bearer(billing.token))
        .send({ planCode: 'professional', billingPeriod: 'yearly', overrides: { limits: { users: 7 }, features: { api: false } } })
        .expect(200);

      expect(res.body.data.effect).toBe('immediate');
      expect(res.body.data.subscription).toMatchObject({ plan: { code: 'professional' }, billingPeriod: 'yearly' });
      expect(res.body.data.subscription.entitlements.limits.users).toBe(7);
      expect(res.body.data.subscription.entitlements.features.api).toBe(false);
      expect(res.body.data.invoice).toMatchObject({ kind: 'conversion', status: 'open' });
      const detail = await http(app).get(`${PLATFORM}/tenants/${tenant.tenantId}`).set(bearer(admin.token)).expect(200);
      expect(detail.body.data.modules).toEqual(expect.arrayContaining(['imaging', 'maternity']));

      await http(app).post(`${PLATFORM}/subscriptions/${tenant.tenantId}/change`).set(bearer(admin.token)).send({ planCode: 'inconnu', billingPeriod: 'monthly' }).expect(404);
      await http(app).post(`${PLATFORM}/subscriptions/${tenant.tenantId}/change`).set(bearer(admin.token)).send({ planCode: 'basic', billingPeriod: 'weekly' }).expect(422);
      await http(app)
        .post(`${PLATFORM}/subscriptions/${tenant.tenantId}/change`)
        .set(bearer(admin.token))
        .send({ planCode: 'basic', billingPeriod: 'monthly', overrides: { limits: { users: -1 } } })
        .expect(422);
    });
  });

  describe('tableau de bord et audit', () => {
    it('agrège établissements, utilisateurs, MRR/ARR par devise et factures en retard', async () => {
      const res = await http(app).get(`${PLATFORM}/dashboard`).set(bearer(admin.token)).expect(200);

      expect(res.body.data.tenants.total).toBeGreaterThanOrEqual(2);
      expect(res.body.data.tenants).toEqual(
        expect.objectContaining({ active: expect.any(Number), trial: expect.any(Number), suspended: expect.any(Number) }),
      );
      expect(res.body.data.users).toBeGreaterThanOrEqual(2);
      expect(res.body.data.overdueInvoices).toBeGreaterThanOrEqual(0);
      for (const value of [...Object.values(res.body.data.mrr), ...Object.values(res.body.data.arr)]) {
        expect(value).toMatch(/^\d+\.\d{2}$/);
      }
      expect(JSON.stringify(res.body.data)).not.toMatch(/lastName|firstName/);
    });

    it('calcule MRR et ARR sur les abonnements actifs (mensuel × 12, annuel tel quel)', async () => {
      const tenant = await createTenantFixture(app, { prefix: 'cons-mrr', subscriptionPlan: 'basic' });
      const read = async () => (await http(app).get(`${PLATFORM}/dashboard`).set(bearer(admin.token)).expect(200)).body.data as { arr: Record<string, string>; mrr: Record<string, string> };
      const before = await read();
      await app.get(PlatformDb).run((tx) => tx.subscription.update({ where: { tenantId: tenant.tenantId }, data: { status: 'active' } }));

      const after = await read();

      const delta = (key: 'arr' | 'mrr') => Math.round((Number(after[key]['XOF']) - Number(before[key]['XOF'] ?? '0')) * 100);
      expect(delta('arr')).toBe(25_000_00 * 12);
      expect(delta('mrr')).toBe(25_000_00);
    });

    it('expose le journal d’audit filtrable par établissement (super_admin seulement)', async () => {
      const res = await http(app).get(`${PLATFORM}/dashboard/audit-logs`).query({ tenantId: tenantB.tenantId }).set(bearer(admin.token)).expect(200);
      const actions = (res.body.data as { action: string }[]).map((l) => l.action);
      expect(actions).toEqual(expect.arrayContaining(['tenant.suspended', 'tenant.reactivated']));
      expect(res.body.meta.pagination).toBeDefined();
    });
  });
});
