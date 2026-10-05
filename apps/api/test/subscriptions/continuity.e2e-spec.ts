import type { INestApplication } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Clock } from '../../src/common/time/clock';
import { PlatformDb } from '../../src/infrastructure/prisma/platform-db.service';
import { SubscriptionLifecycleService } from '../../src/modules/subscriptions/services/subscription-lifecycle.service';
import { createPatientRow, createPractitionerRow, slot } from '../appointments/appointment-fixtures';
import {
  bearer as userBearer,
  createBillingTenant,
  createRegisterRow,
  draftInvoice,
  http,
  issueInvoice,
  openSessionOk,
  payCash,
  seedCatalog,
  BILLING,
  type Catalog,
} from '../billing/billing-fixtures';
import { bearer } from '../helpers/platform';
import { createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { MS_PER_DAY, SUBSCRIPTION, makeActive, patchSubscription, tenantStatusOf } from './subscription-fixtures';

const suspend = (app: INestApplication, tenantId: string): Promise<unknown> =>
  app.get(PlatformDb).run((tx) => tx.tenant.update({ where: { id: tenantId }, data: { status: 'suspended' } }));

describe('continuité des soins (docs/09 §R) et statut d’abonnement', () => {
  let app: INestApplication;
  let tenant: TenantFixture;
  let catalog: Catalog;
  let patientId: string;
  let receptionist: UserFixture;
  let cashier: UserFixture;
  let doctor: UserFixture;

  beforeAll(async () => {
    app = await createTestApp();
    tenant = await createBillingTenant(app, 'cont');
    catalog = await seedCatalog(app, tenant);
    patientId = await createPatientRow(app, tenant);
    receptionist = await createUserWithRole(app, tenant, 'receptionist');
    cashier = await createUserWithRole(app, tenant, 'cashier');
    doctor = await createUserWithRole(app, tenant, 'doctor');
  });

  afterAll(async () => {
    await app?.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('établissement suspendu : l’accueil, la facturation et l’encaissement continuent', () => {
    it('autorise création + émission de facture, ouverture de caisse, encaissement espèces et arrivée du patient', async () => {
      const booked = await http(app)
        .post('/api/v1/appointments')
        .set(userBearer(receptionist))
        .send({ patientId, practitionerId: await createPractitionerRow(app, tenant), siteId: tenant.mainSiteId, ...slot(0) })
        .expect(201);
      await suspend(app, tenant.tenantId);

      const draft = await draftInvoice(app, receptionist, tenant, patientId, catalog);
      const issued = await issueInvoice(app, receptionist, draft.id);
      const session = await openSessionOk(app, cashier, await createRegisterRow(app, tenant));
      const paid = await payCash(app, cashier, issued.id, '8500.00', session.id);
      vi.spyOn(app.get(Clock), 'now').mockReturnValue(new Date(Date.parse(booked.body.data.startsAt) - 2 * 3_600_000));
      const checkIn = await http(app).post(`/api/v1/appointments/${booked.body.data.id}/status`).set(userBearer(receptionist)).send({ status: 'checked_in' });

      expect(issued.status).toBe('issued');
      expect(paid.status).toBe(201);
      expect(checkIn.status).toBe(200);
    });

    it('refuse toujours l’annulation de facture et la création d’un site (écritures non essentielles)', async () => {
      const accountant = await createUserWithRole(app, tenant, 'accountant');
      const draft = await draftInvoice(app, receptionist, tenant, patientId, catalog);

      const voided = await http(app).post(`${BILLING}/invoices/${draft.id}/void`).set(userBearer(accountant)).send({ reasonCode: 'duplicate' });
      const site = await http(app).post('/api/v1/org/sites').set(bearer(tenant.adminToken)).send({ code: 'NOPE', name: 'Bloqué' });

      expect(voided.status).toBe(403);
      expect(voided.body.code).toBe('subscription_suspended');
      expect(site.status).toBe(403);
    });
  });

  describe('GET /subscription/status (R1)', () => {
    it('est lisible par un soignant sans permission d’abonnement et ne contient aucune donnée financière', async () => {
      const fresh = await createBillingTenant(app, 'cont-st');
      const nurse = await createUserWithRole(app, fresh, 'doctor');
      await patchSubscription(app, fresh.tenantId, { status: 'trial', trialEndsAt: new Date(Date.now() + 10.5 * MS_PER_DAY) });

      const res = await http(app).get(`${SUBSCRIPTION}/status`).set(userBearer(nurse)).expect(200);

      expect(res.body.data).toEqual({ status: 'trial', trialEndsAt: expect.any(String), daysLeft: 11, mode: 'normal' });
    });

    it.each([
      ['active', 'normal'],
      ['past_due', 'normal'],
      ['grace', 'restricted'],
      ['suspended', 'continuity'],
      ['cancelled', 'continuity'],
      ['expired', 'continuity'],
    ] as const)('statut %s ⇒ mode %s', async (status, mode) => {
      const fresh = await createBillingTenant(app, `cont-${status.replace("_", "")}`);
      await patchSubscription(app, fresh.tenantId, { status, trialEndsAt: null });

      const res = await http(app).get(`${SUBSCRIPTION}/status`).set(bearer(fresh.adminToken)).expect(200);

      expect(res.body.data).toEqual({ status, trialEndsAt: null, daysLeft: null, mode });
    });

    it('exige une authentification', async () => {
      await http(app).get(`${SUBSCRIPTION}/status`).expect(401);
    });
  });

  describe('résiliation effective (cancelled) = lecture seule', () => {
    it('suspend l’établissement à la résiliation, et le réactive au paiement', async () => {
      const fresh = await createBillingTenant(app, 'cont-canc');
      const periodEnd = new Date(Date.now() - MS_PER_DAY);
      await makeActive(app, fresh.tenantId, periodEnd, { cancelAtPeriodEnd: true });

      await app.get(SubscriptionLifecycleService).runLifecycle(new Date(), { tenantIds: [fresh.tenantId] });

      expect(await tenantStatusOf(app, fresh.tenantId)).toBe('suspended');
      const denied = await http(app).post('/api/v1/org/sites').set(bearer(fresh.adminToken)).send({ code: 'X9', name: 'Bloqué' }).expect(403);
      expect(denied.body.code).toBe('subscription_suspended');
    });
  });
});
