import { createHash, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { SaasInvoiceView } from '@ghmt/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlatformDb } from '../../src/infrastructure/prisma/platform-db.service';
import { createTenantFixture, type TenantFixture } from '../helpers/fixtures';
import { bearer, http, platformClientIp } from '../helpers/platform';
import { createTestApp } from '../helpers/test-app';
import { SUBSCRIPTION, createDoubles, openConversionInvoice, publishPaymentSucceeded } from './subscription-fixtures';

describe('subscriptions : paiement des factures SaaS (revue sécurité M5, M6)', () => {
  const doubles = createDoubles();
  let app: INestApplication;
  let tenant: TenantFixture;
  let invoice: SaasInvoiceView;

  const pay = (payerPhone: string) => http(app).post(`${SUBSCRIPTION}/invoices/${invoice.id}/pay`).set(bearer(tenant.adminToken)).send({ payerPhone });

  beforeAll(async () => {
    app = await createTestApp({}, { providerOverrides: doubles.overrides });
    tenant = await createTenantFixture(app, { prefix: 'sec-saas', subscriptionPlan: 'trial' });
    invoice = await openConversionInvoice(app, tenant);
  });
  afterAll(async () => {
    await app?.close();
  });

  describe('M5 : clé d’idempotence sans empreinte non salée du téléphone', () => {
    it('ne contient ni le numéro ni son SHA-256 (devinable par force brute), mais reste stable pour un même numéro', async () => {
      const phone = '+221771234567';

      await pay(phone).expect(200);
      await pay(phone).expect(200);
      await pay('+221779999999').expect(200);

      const keys = doubles.gateway.initiated.slice(-3).map((call) => call.idempotencyKey);
      const unsalted = createHash('sha256').update(phone).digest('hex').slice(0, 16);
      expect(keys[0]).not.toContain(unsalted);
      expect(keys[0]).not.toContain(phone);
      expect(keys[1]).toBe(keys[0]);
      expect(keys[2]).not.toBe(keys[0]);
    });
  });

  describe('M6 : second paiement d’une facture déjà payée', () => {
    it('audite saas_invoice.duplicate_payment pour une autre tentative, pas pour le rejeu de la tentative payante', async () => {
      const winning = randomUUID();
      const other = randomUUID();
      await publishPaymentSucceeded(app, tenant, invoice, { attemptId: winning });

      await publishPaymentSucceeded(app, tenant, invoice, { attemptId: winning });
      await publishPaymentSucceeded(app, tenant, invoice, { attemptId: other });
      await publishPaymentSucceeded(app, tenant, invoice, { attemptId: other });

      const logs = await app.get(PlatformDb).run((tx) => tx.platformAuditLog.findMany({ where: { action: 'saas_invoice.duplicate_payment', resourceId: invoice.id } }));
      expect(logs).toHaveLength(1);
      expect(logs[0]?.changes).toMatchObject({ attemptId: other, amount: invoice.total });
    });
  });

  describe('L7 : limitation de débit de POST /subscription/change', () => {
    it('répond 429 au-delà de 10 demandes par minute et par IP', async () => {
      const ip = platformClientIp();
      const attempt = () =>
        http(app).post(`${SUBSCRIPTION}/change`).set(bearer(tenant.adminToken)).set('X-Forwarded-For', ip).send({ planCode: 'inexistant', billingPeriod: 'monthly' });

      for (let i = 0; i < 10; i += 1) await attempt().expect(404);

      await attempt().expect(429);
    });
  });
});
