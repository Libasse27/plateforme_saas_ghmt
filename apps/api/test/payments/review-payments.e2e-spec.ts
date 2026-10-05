import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatformDb } from '../../src/infrastructure/prisma/platform-db.service';
import { hmacSha256Hex } from '../../src/modules/payments/domain/webhook-signature';
import { PaymentRetryJob } from '../../src/modules/payments/services/payment-retry.job';
import { createTenantFixture, type TenantFixture } from '../helpers/fixtures';
import {
  WEBHOOKS,
  attemptRow,
  createPaymentsApp,
  eventRows,
  gatewayOf,
  http,
  initiateInput,
  patchSandboxTransaction,
  postSandboxWebhook,
  recordPaymentEvents,
  signedSandboxWebhook,
  type PublishedEvents,
} from './payments-fixtures';

const MINUTE_MS = 60_000;
const SECRET = 'secret-cinetpay-revue';
const SITE_ID = '105888';
const CINETPAY_ENV = {
  CINETPAY_API_KEY: 'cle-api-revue',
  CINETPAY_SITE_ID: SITE_ID,
  CINETPAY_SECRET_KEY: SECRET,
  CINETPAY_NOTIFY_URL: 'https://api.ghmt.test/api/v1/webhooks/payments/cinetpay',
};
const FIELD_ORDER = [
  'cpm_site_id', 'cpm_trans_id', 'cpm_trans_date', 'cpm_amount', 'cpm_currency', 'signature', 'payment_method',
  'cel_phone_num', 'cpm_phone_prefixe', 'cpm_language', 'cpm_version', 'cpm_payment_config', 'cpm_page_action',
  'cpm_custom', 'cpm_designation', 'cpm_error_message',
];
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('payments : échec technique ou refus explicite à l’initiation', () => {
  const fetchMock = vi.fn();
  let app: INestApplication;
  let tenant: TenantFixture;

  beforeAll(async () => {
    app = await createPaymentsApp({ env: { ...CINETPAY_ENV, PAYMENTS_ROUTES: '{"*":["cinetpay"]}' }, fetch: fetchMock as unknown as typeof fetch });
    tenant = await createTenantFixture(app);
  });
  beforeEach(() => {
    fetchMock.mockReset();
  });
  afterAll(async () => {
    await app?.close();
  });

  it('laisse la tentative « pending » quand le fournisseur ne répond pas (échec technique) et expose son identifiant', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const error = await gatewayOf(app).initiate(initiateInput(tenant.tenantId)).catch((e: unknown) => e);

    expect(error).toMatchObject({ status: 502, code: 'payment_provider_unavailable', attemptRetained: true, attemptId: expect.any(String) });
    expect((await attemptRow(app, (error as { attemptId: string }).attemptId)).status).toBe('pending');
  });

  it('traite une erreur 5xx comme un échec technique (tentative conservée)', async () => {
    fetchMock.mockResolvedValue(json({ message: 'boom' }, 503));

    const error = await gatewayOf(app).initiate(initiateInput(tenant.tenantId)).catch((e: unknown) => e);

    expect(error).toMatchObject({ attemptRetained: true });
    expect((await attemptRow(app, (error as { attemptId: string }).attemptId)).status).toBe('pending');
  });

  it('passe la tentative à « failed » seulement sur refus explicite du fournisseur', async () => {
    fetchMock.mockResolvedValue(json({ code: '-1', message: 'INVALID_PARAMS' }, 400));

    const error = await gatewayOf(app).initiate(initiateInput(tenant.tenantId)).catch((e: unknown) => e);

    expect(error).toMatchObject({ status: 502, code: 'payment_provider_unavailable', attemptRetained: false });
    const row = await attemptRow(app, (error as { attemptId: string }).attemptId);
    expect(row).toMatchObject({ status: 'failed', failureReason: 'refused_by_provider' });
  });

  it('audite le passage en échec de la tentative (journal plateforme)', async () => {
    fetchMock.mockResolvedValue(json({ code: '-1', message: 'INVALID_PARAMS' }, 400));

    const error = (await gatewayOf(app).initiate(initiateInput(tenant.tenantId)).catch((e: unknown) => e)) as { attemptId: string };

    const logs = await app.get(PlatformDb).run((tx) => tx.platformAuditLog.findMany({ where: { action: 'payment.attempt_failed', resourceId: error.attemptId } }));
    expect(logs).toHaveLength(1);
    expect(logs[0]?.changes).toMatchObject({ reason: 'refused_by_provider' });
  });
});

describe('payments : aucun fournisseur actif', () => {
  it('utilise le même code payment_provider_unavailable (503) et ne crée aucune tentative', async () => {
    const app = await createPaymentsApp({ env: { PAYMENTS_SANDBOX_ENABLED: 'false', PAYMENTS_ROUTES: '{"*":["cinetpay"]}' } });
    try {
      const tenant = await createTenantFixture(app);
      await expect(gatewayOf(app).initiate(initiateInput(tenant.tenantId))).rejects.toMatchObject({ status: 503, code: 'payment_provider_unavailable' });
    } finally {
      await app.close();
    }
  });
});

describe('payments : webhooks CinetPay stockés expurgés', () => {
  const fetchMock = vi.fn();
  let app: INestApplication;
  let tenant: TenantFixture;

  beforeAll(async () => {
    app = await createPaymentsApp({ env: { ...CINETPAY_ENV, PAYMENTS_ROUTES: '{"*":["cinetpay"]}' }, fetch: fetchMock as unknown as typeof fetch });
    tenant = await createTenantFixture(app);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('ne conserve ni le téléphone ni les identifiants du payeur, mais l’empreinte SHA-256 du corps reçu', async () => {
    fetchMock.mockResolvedValueOnce(json({ code: '201', data: { payment_url: 'https://checkout.cinetpay.com/payment/xyz' } }));
    const { attemptId } = await gatewayOf(app).initiate(initiateInput(tenant.tenantId));
    const reference = (await attemptRow(app, attemptId)).providerReference as string;
    const fields: Record<string, string> = Object.fromEntries(FIELD_ORDER.map((name) => [name, '']));
    Object.assign(fields, {
      cpm_site_id: SITE_ID, cpm_trans_id: reference, cpm_amount: '15000', cpm_currency: 'XOF', cpm_error_message: 'SUCCES',
      cel_phone_num: '771234567', cpm_phone_prefixe: '221', cpm_custom: 'Awa Diop',
    });
    const token = hmacSha256Hex(SECRET, FIELD_ORDER.map((name) => fields[name]).join(''));
    fetchMock.mockResolvedValueOnce(json({ code: '00', data: { status: 'ACCEPTED', amount: '15000', currency: 'XOF' } }));

    await http(app).post(`${WEBHOOKS}/cinetpay`).set('x-token', token).send(fields).expect(200);

    const [event] = await eventRows(app, attemptId);
    expect(event?.rawBody).not.toContain('771234567');
    expect(event?.rawBody).not.toContain('Awa Diop');
    expect(event?.rawBody).toContain(reference);
    expect(event?.bodySha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('payments : expiration à 30 minutes, dernier contrôle fournisseur, succès tardif', () => {
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

  async function newAttempt(ageMs: number, purpose: 'patient_invoice' | 'saas_invoice' = 'patient_invoice', amount = '15000.00') {
    const { attemptId } = await gatewayOf(app).initiate(initiateInput(tenant.tenantId, { purpose, amount }));
    const createdAt = new Date(Date.now() - ageMs);
    await app.get(PlatformDb).run((tx) => tx.paymentAttempt.update({ where: { id: attemptId }, data: { createdAt } }));
    return { attemptId, reference: (await attemptRow(app, attemptId)).providerReference as string };
  }

  it('expire une tentative de facture patient après 30 minutes, pas avant', async () => {
    const young = await newAttempt(29 * MINUTE_MS);
    const old = await newAttempt(31 * MINUTE_MS);

    await job().runOnce(new Date(), { tenantIds: [tenant.tenantId] });

    expect((await attemptRow(app, young.attemptId)).status).toBe('pending');
    expect(await attemptRow(app, old.attemptId)).toMatchObject({ status: 'failed', failureReason: 'expired' });
  });

  it('laisse vivre 24 h une tentative d’abonnement SaaS', async () => {
    const saas = await newAttempt(31 * MINUTE_MS, 'saas_invoice');

    await job().runOnce(new Date(), { tenantIds: [tenant.tenantId] });

    expect((await attemptRow(app, saas.attemptId)).status).toBe('pending');
  });

  it('interroge une dernière fois le fournisseur avant d’expirer : un succès est enregistré, pas expiré', async () => {
    const { attemptId, reference } = await newAttempt(31 * MINUTE_MS);
    await patchSandboxTransaction(app, reference, { status: 'succeeded' });

    await job().runOnce(new Date(), { tenantIds: [tenant.tenantId] });

    expect((await attemptRow(app, attemptId)).status).toBe('succeeded');
    expect(published.succeeded.some((e) => e.attemptId === attemptId)).toBe(true);
  });

  it('signale par un audit de rapprochement un succès fournisseur au montant différent', async () => {
    const { attemptId, reference } = await newAttempt(31 * MINUTE_MS);
    await patchSandboxTransaction(app, reference, { status: 'succeeded', amount: '14000.00' });

    await job().runOnce(new Date(), { tenantIds: [tenant.tenantId] });

    expect(await attemptRow(app, attemptId)).toMatchObject({ status: 'failed', failureReason: 'amount_mismatch' });
    const logs = await app.get(PlatformDb).run((tx) => tx.platformAuditLog.findMany({ where: { action: 'payment.amount_mismatch', resourceId: attemptId } }));
    expect(logs).toHaveLength(1);
    expect(logs[0]?.changes).toMatchObject({ expected: '15000.00' });
  });

  it('enregistre un succès tardif : le webhook d’une tentative expirée la fait passer à « succeeded » et republie payment.succeeded', async () => {
    const { attemptId, reference } = await newAttempt(31 * MINUTE_MS);
    await job().runOnce(new Date(), { tenantIds: [tenant.tenantId] });
    expect((await attemptRow(app, attemptId)).status).toBe('failed');
    await patchSandboxTransaction(app, reference, { status: 'succeeded' });

    await postSandboxWebhook(app, signedSandboxWebhook(app, reference)).expect(200);

    expect(await attemptRow(app, attemptId)).toMatchObject({ status: 'succeeded', failureReason: null });
    expect(published.succeeded.filter((e) => e.attemptId === attemptId)).toHaveLength(1);
  });

  it('ne rend jamais « succeeded » une tentative refusée pour montant différent', async () => {
    const { attemptId, reference } = await newAttempt(1 * MINUTE_MS);
    await patchSandboxTransaction(app, reference, { status: 'succeeded', amount: '1.00' });
    await postSandboxWebhook(app, signedSandboxWebhook(app, reference)).expect(200);
    await patchSandboxTransaction(app, reference, { amount: '15000.00' });

    await postSandboxWebhook(app, signedSandboxWebhook(app, reference)).expect(200);

    expect((await attemptRow(app, attemptId)).status).toBe('failed');
  });

  it('M5 : une nouvelle tentative pour la même facture SaaS abandonne la précédente (une seule « pending » par facture)', async () => {
    const referenceId = (await import('node:crypto')).randomUUID();
    const first = await gatewayOf(app).initiate(initiateInput(tenant.tenantId, { purpose: 'saas_invoice', referenceId, amount: '88500.00' }));

    const second = await gatewayOf(app).initiate(initiateInput(tenant.tenantId, { purpose: 'saas_invoice', referenceId, amount: '88500.00' }));

    expect(second.attemptId).not.toBe(first.attemptId);
    expect(await attemptRow(app, first.attemptId)).toMatchObject({ status: 'cancelled', failureReason: 'abandoned' });
    expect((await attemptRow(app, second.attemptId)).status).toBe('pending');
  });

  it('M5 : la base refuse deux tentatives « pending » pour une même facture SaaS (index unique partiel)', async () => {
    const referenceId = (await import('node:crypto')).randomUUID();
    await gatewayOf(app).initiate(initiateInput(tenant.tenantId, { purpose: 'saas_invoice', referenceId }));
    const row = {
      purpose: 'saas_invoice', tenantId: tenant.tenantId, referenceId, amount: '15000.00', currency: 'XOF', channel: 'mobile_money', provider: 'sandbox', status: 'pending',
      description: 'doublon', idempotencyKey: `dup-${referenceId}`,
    };

    await expect(app.get(PlatformDb).run((tx) => tx.paymentAttempt.create({ data: row }))).rejects.toMatchObject({ code: 'P2002' });
  });

  it('L8 : tentatives et événements ne se suppriment jamais ; le corps d’un événement reçu est immuable', async () => {
    const { attemptId, reference } = await newAttempt(1 * MINUTE_MS);
    await patchSandboxTransaction(app, reference, { status: 'succeeded' });
    await postSandboxWebhook(app, signedSandboxWebhook(app, reference)).expect(200);
    const [event] = await eventRows(app, attemptId);

    await expect(app.get(PlatformDb).run((tx) => tx.paymentAttempt.delete({ where: { id: attemptId } }))).rejects.toThrow(/interdit|DELETE/i);
    await expect(app.get(PlatformDb).run((tx) => tx.paymentEvent.delete({ where: { id: event!.id } }))).rejects.toThrow(/interdit|DELETE/i);
    await expect(app.get(PlatformDb).run((tx) => tx.paymentEvent.update({ where: { id: event!.id }, data: { rawBody: 'falsifié' } }))).rejects.toThrow(/immuable/i);
    await expect(app.get(PlatformDb).run((tx) => tx.$executeRawUnsafe('TRUNCATE platform.payment_events'))).rejects.toThrow(/permission denied|interdit/i);
  });

  it('cancel() abandonne une tentative en attente sans publier d’événement ; un règlement final est conservé', async () => {
    const pending = await newAttempt(1 * MINUTE_MS);
    const done = await newAttempt(1 * MINUTE_MS);
    await patchSandboxTransaction(app, done.reference, { status: 'succeeded' });
    await gatewayOf(app).refresh(done.attemptId);
    const before = published.failed.length;

    const cancelled = await gatewayOf(app).cancel(pending.attemptId);
    const kept = await gatewayOf(app).cancel(done.attemptId);

    expect(cancelled).toEqual({ status: 'cancelled' });
    expect(kept).toEqual({ status: 'succeeded' });
    expect(await attemptRow(app, pending.attemptId)).toMatchObject({ status: 'cancelled', failureReason: 'abandoned' });
    expect(published.failed.length).toBe(before);
  });
});
