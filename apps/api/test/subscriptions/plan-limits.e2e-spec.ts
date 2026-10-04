import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlatformDb } from '../../src/infrastructure/prisma/platform-db.service';
import { createPatientRow, createPractitionerRow, slot } from '../appointments/appointment-fixtures';
import { createTenantFixture, createUserWithRole, type TenantFixture } from '../helpers/fixtures';
import { bearer, http } from '../helpers/platform';
import { createTestApp } from '../helpers/test-app';
import { patchSubscription } from './subscription-fixtures';

let counter = 0;
const newUser = (tenant: TenantFixture) => ({ fullName: 'Agent Test', email: `agent${(counter += 1)}-${Math.random().toString(36).slice(2, 6)}@${tenant.slug}.test` });

describe('subscriptions : limites du plan (dures et souples)', () => {
  let app: INestApplication;

  const createUser = (tenant: TenantFixture, body: Record<string, unknown> = newUser(tenant)) =>
    http(app).post('/api/v1/iam/users').set(bearer(tenant.adminToken)).send(body);
  const createSite = (tenant: TenantFixture, code: string) =>
    http(app).post('/api/v1/org/sites').set(bearer(tenant.adminToken)).send({ code, name: `Site ${code}` });
  const withOverrides = (tenant: TenantFixture, limits: Record<string, number | null>) =>
    patchSubscription(app, tenant.tenantId, { overrides: { limits } });

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('utilisateurs (limite dure : actifs + invités)', () => {
    it('refuse la création au-delà du plan (403 plan_limit_reached, détail { limit, current })', async () => {
      const tenant = await createTenantFixture(app, { prefix: 'lim-users', subscriptionPlan: 'basic' });
      for (let i = 0; i < 4; i += 1) await createUser(tenant).expect(201);

      const res = await createUser(tenant).expect(403);

      expect(res.body.code).toBe('plan_limit_reached');
      expect(res.body.details).toEqual({ metric: 'users', limit: 5, current: 5 });
      expect(res.body.detail).toContain('limite');
    });

    it('compte les invités mais pas les comptes désactivés ; réactiver un compte consomme une place', async () => {
      const tenant = await createTenantFixture(app, { prefix: 'lim-disabled', subscriptionPlan: 'basic' });
      const created: string[] = [];
      for (let i = 0; i < 4; i += 1) created.push((await createUser(tenant).expect(201)).body.data.id);
      await createUser(tenant).expect(403);

      await http(app).post(`/api/v1/iam/users/${created[0]}/disable`).set(bearer(tenant.adminToken)).expect(200);
      await createUser(tenant).expect(201);

      const res = await http(app).post(`/api/v1/iam/users/${created[0]}/enable`).set(bearer(tenant.adminToken)).expect(403);
      expect(res.body.code).toBe('plan_limit_reached');
    });

    it('applique la limite sous concurrence : jamais plus que le plan (verrou d’avis par tenant)', async () => {
      const tenant = await createTenantFixture(app, { prefix: 'lim-conc', subscriptionPlan: 'basic' });
      await withOverrides(tenant, { users: 3 });

      const results = await Promise.all(Array.from({ length: 6 }, () => createUser(tenant)));

      expect(results.filter((r) => r.status === 201)).toHaveLength(2);
      expect(results.filter((r) => r.status === 403).every((r) => r.body.code === 'plan_limit_reached')).toBe(true);
    });

    it('une dérogation d’abonnement relève (ou supprime) la limite du plan', async () => {
      const tenant = await createTenantFixture(app, { prefix: 'lim-override', subscriptionPlan: 'basic' });
      await withOverrides(tenant, { users: null });
      for (let i = 0; i < 6; i += 1) await createUser(tenant).expect(201);
    });

    it('n’impose aucune limite à un établissement sans abonnement (historique)', async () => {
      const tenant = await createTenantFixture(app, { prefix: 'lim-legacy', subscriptionPlan: 'basic' });
      await app.get(PlatformDb).run((tx) => tx.subscription.delete({ where: { tenantId: tenant.tenantId } }));
      for (let i = 0; i < 6; i += 1) await createUser(tenant).expect(201);
    });

    it('ne limite pas un plan Enterprise (utilisateurs illimités)', async () => {
      const tenant = await createTenantFixture(app, { prefix: 'lim-ent' });
      for (let i = 0; i < 6; i += 1) await createUser(tenant).expect(201);
    });
  });

  describe('sites (limite dure)', () => {
    it('refuse le site supplémentaire au-delà du plan avec le détail', async () => {
      const tenant = await createTenantFixture(app, { prefix: 'lim-sites', subscriptionPlan: 'basic' });

      const res = await createSite(tenant, 'DEUX').expect(403);

      expect(res.body.code).toBe('plan_limit_reached');
      expect(res.body.details).toEqual({ metric: 'sites', limit: 1, current: 1 });
    });

    it('accepte jusqu’à la limite du plan Standard (2 sites) puis refuse', async () => {
      const tenant = await createTenantFixture(app, { prefix: 'lim-sites2', subscriptionPlan: 'standard' });
      await createSite(tenant, 'DEUX').expect(201);
      const res = await createSite(tenant, 'TROIS').expect(403);
      expect(res.body.details).toMatchObject({ metric: 'sites', limit: 2, current: 2 });
    });
  });

  describe('rendez-vous du mois (limite souple à 120 %)', () => {
    async function bookAs(tenant: TenantFixture, token: string, patientId: string, index: number, source?: string) {
      return http(app)
        .post('/api/v1/appointments')
        .set(bearer(token))
        .send({
          patientId,
          practitionerId: await createPractitionerRow(app, tenant),
          siteId: tenant.mainSiteId,
          ...slot(index * 30),
          ...(source ? { source } : {}),
        });
    }

    it('au-delà de 120 % seules les sources en ligne sont refusées ; le guichet n’est jamais bloqué', async () => {
      const tenant = await createTenantFixture(app, { prefix: 'lim-rdv', subscriptionPlan: 'basic' });
      await withOverrides(tenant, { appointmentsMonthly: 5 });
      const reception = await createUserWithRole(app, tenant, 'receptionist');
      const patientId = await createPatientRow(app, tenant);

      // 6 rendez-vous (= 120 % de 5) : le guichet, le téléphone et même le web sont acceptés jusque-là.
      for (let i = 0; i < 5; i += 1) await bookAs(tenant, reception.token, patientId, i).then((r) => expect(r.status).toBe(201));
      await bookAs(tenant, reception.token, patientId, 5, 'web').then((r) => expect(r.status).toBe(201));

      const refused = await bookAs(tenant, reception.token, patientId, 6, 'web');
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('plan_limit_reached');
      expect(refused.body.details).toEqual({ metric: 'appointmentsMonthly', limit: 5, current: 6 });
      await bookAs(tenant, reception.token, patientId, 7, 'mobile_app').then((r) => expect(r.status).toBe(403));

      await bookAs(tenant, reception.token, patientId, 8, 'front_desk').then((r) => expect(r.status).toBe(201));
      await bookAs(tenant, reception.token, patientId, 9, 'phone').then((r) => expect(r.status).toBe(201));
    });

    it('un quota illimité (null) n’est jamais atteint', async () => {
      const tenant = await createTenantFixture(app, { prefix: 'lim-rdv-null', subscriptionPlan: 'basic' });
      await withOverrides(tenant, { appointmentsMonthly: null });
      const reception = await createUserWithRole(app, tenant, 'receptionist');
      const patientId = await createPatientRow(app, tenant);
      for (let i = 0; i < 3; i += 1) await bookAs(tenant, reception.token, patientId, i, 'web').then((r) => expect(r.status).toBe(201));
    });
  });

  it('les patients actifs ne sont jamais bloquants (limite informative)', async () => {
    const tenant = await createTenantFixture(app, { prefix: 'lim-pat', subscriptionPlan: 'basic' });
    await withOverrides(tenant, { activePatients: 1 });
    const reception = await createUserWithRole(app, tenant, 'receptionist');
    for (let i = 0; i < 3; i += 1) {
      const res = await http(app)
        .post('/api/v1/patients')
        .set(bearer(reception.token))
        .send({ lastName: `Patient${i}`, firstName: 'Test', sex: 'female', birthDate: '1990-01-01' });
      expect(res.status).toBe(201);
    }
  });
});
