import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainEventBus } from '../../src/common/events/domain-event-bus';
import { PlatformDb } from '../../src/infrastructure/prisma/platform-db.service';
import { PaymentRetryJob } from '../../src/modules/payments/services/payment-retry.job';
import { createTenantFixture, type TenantFixture } from '../helpers/fixtures';
import { attemptRow, createPaymentsApp, gatewayOf, initiateInput, patchSandboxTransaction, recordPaymentEvents, type PublishedEvents } from './payments-fixtures';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

describe('payments : relance des tentatives en attente', () => {
  let app: INestApplication;
  let tenant: TenantFixture;
  let published: PublishedEvents;

  beforeAll(async () => {
    app = await createPaymentsApp();
    tenant = await createTenantFixture(app);
    published = recordPaymentEvents(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  const job = (): PaymentRetryJob => app.get(PaymentRetryJob);

  async function backdate(attemptId: string, ageMs: number): Promise<void> {
    const createdAt = new Date(Date.now() - ageMs);
    await app.get(PlatformDb).run((tx) => tx.paymentAttempt.update({ where: { id: attemptId }, data: { createdAt } }));
  }

  async function newAttempt(ageMs: number): Promise<{ attemptId: string; reference: string }> {
    const { attemptId } = await gatewayOf(app).initiate(initiateInput(tenant.tenantId));
    await backdate(attemptId, ageMs);
    return { attemptId, reference: (await attemptRow(app, attemptId)).providerReference as string };
  }

  it('interroge le fournisseur pour une tentative en attente depuis plus de 10 minutes et la règle', async () => {
    const { attemptId, reference } = await newAttempt(11 * MINUTE_MS);
    await patchSandboxTransaction(app, reference, { status: 'succeeded' });

    const report = await job().runOnce(new Date());

    expect(report.checked).toBeGreaterThanOrEqual(1);
    expect((await attemptRow(app, attemptId)).status).toBe('succeeded');
    expect(published.succeeded.filter((e) => e.attemptId === attemptId)).toHaveLength(1);
  });

  it('laisse en attente une tentative encore non payée (et mémorise la vérification)', async () => {
    const { attemptId } = await newAttempt(11 * MINUTE_MS);

    await job().runOnce(new Date());

    const row = await attemptRow(app, attemptId);
    expect(row.status).toBe('pending');
    expect(row.checkCount).toBe(1);
    expect(row.lastCheckedAt).not.toBeNull();
  });

  it('ignore une tentative de moins de 10 minutes', async () => {
    const { attemptId, reference } = await newAttempt(2 * MINUTE_MS);
    await patchSandboxTransaction(app, reference, { status: 'succeeded' });

    await job().runOnce(new Date());

    expect((await attemptRow(app, attemptId)).status).toBe('pending');
  });

  it('ne réinterroge pas une tentative vérifiée il y a moins de 5 minutes', async () => {
    const { attemptId } = await newAttempt(11 * MINUTE_MS);
    await job().runOnce(new Date());

    await job().runOnce(new Date());

    expect((await attemptRow(app, attemptId)).checkCount).toBe(1);
  });

  it('expire (payment.failed expired) une tentative en attente depuis plus de 24 h', async () => {
    const { attemptId } = await newAttempt(25 * HOUR_MS);

    const report = await job().runOnce(new Date());

    expect(report.expired).toBeGreaterThanOrEqual(1);
    const row = await attemptRow(app, attemptId);
    expect(row.status).toBe('failed');
    expect(row.failureReason).toBe('expired');
    expect(published.failed.find((e) => e.attemptId === attemptId)).toMatchObject({ reason: 'expired' });
  });

  it('republie un règlement dont l’abonné avait échoué (notified_at absent)', async () => {
    const bus = app.get(DomainEventBus);
    let fail = true;
    bus.subscribe('payment.succeeded', () => (fail ? Promise.reject(new Error('abonné indisponible')) : Promise.resolve()));
    const { attemptId } = await gatewayOf(app).initiate(initiateInput(tenant.tenantId));
    const reference = (await attemptRow(app, attemptId)).providerReference as string;
    await patchSandboxTransaction(app, reference, { status: 'succeeded' });
    await gatewayOf(app).refresh(attemptId);
    expect((await attemptRow(app, attemptId)).notifiedAt).toBeNull();
    const settledAt = new Date(Date.now() - 5 * MINUTE_MS);
    await app.get(PlatformDb).run((tx) => tx.paymentAttempt.update({ where: { id: attemptId }, data: { settledAt } }));

    fail = false;
    const report = await job().runOnce(new Date());

    expect(report.republished).toBeGreaterThanOrEqual(1);
    expect((await attemptRow(app, attemptId)).notifiedAt).not.toBeNull();
  });
});
