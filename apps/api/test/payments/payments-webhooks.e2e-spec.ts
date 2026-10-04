import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

describe('payments : webhooks sandbox (signature, re-vérification, idempotence)', () => {
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

  async function pendingAttempt(overrides = {}) {
    const result = await gatewayOf(app).initiate(initiateInput(tenant.tenantId, overrides));
    const row = await attemptRow(app, result.attemptId);
    return { attemptId: result.attemptId, reference: row.providerReference as string };
  }

  it('règle la tentative et publie payment.succeeded quand signature, statut serveur, montant et devise concordent', async () => {
    const { attemptId, reference } = await pendingAttempt();
    await patchSandboxTransaction(app, reference, { status: 'succeeded' });

    const res = await postSandboxWebhook(app, signedSandboxWebhook(app, reference)).expect(200);

    expect(res.body.data).toMatchObject({ received: true, outcome: 'succeeded' });
    const row = await attemptRow(app, attemptId);
    expect(row.status).toBe('succeeded');
    expect(row.settledAt).not.toBeNull();
    expect(row.notifiedAt).not.toBeNull();
    const event = published.succeeded.find((e) => e.attemptId === attemptId);
    expect(event).toMatchObject({ purpose: 'patient_invoice', tenantId: tenant.tenantId, amount: '15000.00', currency: 'XOF', provider: 'sandbox', providerReference: reference });
  });

  it('conserve le corps brut de l’événement', async () => {
    const { attemptId, reference } = await pendingAttempt();
    await patchSandboxTransaction(app, reference, { status: 'succeeded' });
    const webhook = signedSandboxWebhook(app, reference);

    await postSandboxWebhook(app, webhook).expect(200);

    const [event] = await eventRows(app, attemptId);
    expect(event?.rawBody).toBe(webhook.body);
    expect(event?.processedAt).not.toBeNull();
  });

  it('est idempotent : un rejeu du même événement ne republie rien', async () => {
    const { attemptId, reference } = await pendingAttempt();
    await patchSandboxTransaction(app, reference, { status: 'succeeded' });
    const webhook = signedSandboxWebhook(app, reference);

    await postSandboxWebhook(app, webhook).expect(200);
    const replay = await postSandboxWebhook(app, webhook).expect(200);

    expect(replay.body.data.outcome).toBe('duplicate');
    expect(published.succeeded.filter((e) => e.attemptId === attemptId)).toHaveLength(1);
    expect(await eventRows(app, attemptId)).toHaveLength(1);
  });

  it('ne règle qu’une fois sous webhooks concurrents (identifiants d’événement différents)', async () => {
    const { attemptId, reference } = await pendingAttempt();
    await patchSandboxTransaction(app, reference, { status: 'succeeded' });

    await Promise.all(Array.from({ length: 5 }, () => postSandboxWebhook(app, signedSandboxWebhook(app, reference)).expect(200)));

    expect(published.succeeded.filter((e) => e.attemptId === attemptId)).toHaveLength(1);
    expect((await attemptRow(app, attemptId)).status).toBe('succeeded');
  });

  it('refuse (401) une signature absente, fausse ou calculée sur un autre corps, sans stocker d’événement', async () => {
    const { attemptId, reference } = await pendingAttempt();
    const webhook = signedSandboxWebhook(app, reference);

    await http(app).post(`${WEBHOOKS}/sandbox`).set('content-type', 'application/json').send(webhook.body).expect(401);
    await postSandboxWebhook(app, { body: webhook.body, signature: 'a'.repeat(64) }).expect(401);
    const other = signedSandboxWebhook(app, reference);
    await postSandboxWebhook(app, { body: webhook.body, signature: other.signature }).expect(401);

    expect(await eventRows(app, attemptId)).toHaveLength(0);
    expect((await attemptRow(app, attemptId)).status).toBe('pending');
  });

  it('ne croit pas le webhook seul : sans confirmation du fournisseur, la tentative reste en attente', async () => {
    const { attemptId, reference } = await pendingAttempt();
    // Webhook authentique mais « succès » non confirmé côté fournisseur (statut serveur toujours pending).

    const res = await postSandboxWebhook(app, signedSandboxWebhook(app, reference, { status: 'succeeded' })).expect(200);

    expect(res.body.data.outcome).toBe('pending');
    expect((await attemptRow(app, attemptId)).status).toBe('pending');
    expect(published.succeeded.some((e) => e.attemptId === attemptId)).toBe(false);
  });

  it('refuse de créditer un montant différent de celui de la tentative (payment.failed amount_mismatch)', async () => {
    const { attemptId, reference } = await pendingAttempt();
    await patchSandboxTransaction(app, reference, { status: 'succeeded', amount: '1.00' });

    await postSandboxWebhook(app, signedSandboxWebhook(app, reference)).expect(200);

    const row = await attemptRow(app, attemptId);
    expect(row.status).toBe('failed');
    expect(row.failureReason).toBe('amount_mismatch');
    expect(published.failed.find((e) => e.attemptId === attemptId)).toMatchObject({ reason: 'amount_mismatch' });
    expect(published.succeeded.some((e) => e.attemptId === attemptId)).toBe(false);
  });

  it('refuse de créditer une devise différente', async () => {
    const { attemptId, reference } = await pendingAttempt();
    await patchSandboxTransaction(app, reference, { status: 'succeeded', currency: 'EUR' });

    await postSandboxWebhook(app, signedSandboxWebhook(app, reference)).expect(200);

    expect((await attemptRow(app, attemptId)).failureReason).toBe('amount_mismatch');
  });

  it('publie payment.failed quand le fournisseur confirme l’échec', async () => {
    const { attemptId, reference } = await pendingAttempt();
    await patchSandboxTransaction(app, reference, { status: 'failed' });

    await postSandboxWebhook(app, signedSandboxWebhook(app, reference, { status: 'failed' })).expect(200);

    expect((await attemptRow(app, attemptId)).status).toBe('failed');
    expect(published.failed.find((e) => e.attemptId === attemptId)).toMatchObject({ reason: 'declined_by_provider', amount: '15000.00' });
  });

  it('un règlement est définitif : un webhook ultérieur contradictoire ne change rien', async () => {
    const { attemptId, reference } = await pendingAttempt();
    await patchSandboxTransaction(app, reference, { status: 'succeeded' });
    await postSandboxWebhook(app, signedSandboxWebhook(app, reference)).expect(200);
    await patchSandboxTransaction(app, reference, { status: 'failed' });

    await postSandboxWebhook(app, signedSandboxWebhook(app, reference, { status: 'failed' })).expect(200);

    expect((await attemptRow(app, attemptId)).status).toBe('succeeded');
    expect(published.failed.some((e) => e.attemptId === attemptId)).toBe(false);
  });

  it('acquitte (200) une référence inconnue sans rien créer', async () => {
    const res = await postSandboxWebhook(app, signedSandboxWebhook(app, 'GHinconnue000000000000')).expect(200);

    expect(res.body.data.outcome).toBe('unknown_reference');
  });

  it('répond 404 pour un fournisseur inconnu ou non configuré (CinetPay)', async () => {
    await http(app).post(`${WEBHOOKS}/inconnu`).send({}).expect(404);
    await http(app).post(`${WEBHOOKS}/cinetpay`).send({}).expect(404);
  });

  it('refuse (401) un corps JSON signé mais sans référence exploitable', async () => {
    const body = JSON.stringify({ eventId: randomUUID() });
    const sandboxSigned = signedSandboxWebhook(app, 'x');

    await postSandboxWebhook(app, { body, signature: sandboxSigned.signature }).expect(401);
  });
});

describe('payments : simulation sandbox et reprise (refresh)', () => {
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

  it('POST /webhooks/payments/sandbox/simulate mène la tentative au succès par le même chemin que les webhooks', async () => {
    const { attemptId } = await gatewayOf(app).initiate(initiateInput(tenant.tenantId));

    const res = await http(app).post(`${WEBHOOKS}/sandbox/simulate`).send({ attemptId, outcome: 'success' }).expect(200);

    expect(res.body.data.outcome).toBe('succeeded');
    expect((await attemptRow(app, attemptId)).status).toBe('succeeded');
    expect(published.succeeded.filter((e) => e.attemptId === attemptId)).toHaveLength(1);
    expect(await eventRows(app, attemptId)).toHaveLength(1);
  });

  it('simule un échec', async () => {
    const { attemptId } = await gatewayOf(app).initiate(initiateInput(tenant.tenantId));

    await http(app).post(`${WEBHOOKS}/sandbox/simulate`).send({ attemptId, outcome: 'failure' }).expect(200);

    expect((await attemptRow(app, attemptId)).status).toBe('failed');
  });

  it('refuse une simulation invalide (422) ou sur une tentative inconnue (404)', async () => {
    await http(app).post(`${WEBHOOKS}/sandbox/simulate`).send({ attemptId: 'x', outcome: 'success' }).expect(422);
    await http(app).post(`${WEBHOOKS}/sandbox/simulate`).send({ attemptId: randomUUID(), outcome: 'success' }).expect(404);
  });

  it('refresh règle une tentative payée dont le webhook a été perdu, puis reste idempotent', async () => {
    const { attemptId } = await gatewayOf(app).initiate(initiateInput(tenant.tenantId));
    const reference = (await attemptRow(app, attemptId)).providerReference as string;
    await patchSandboxTransaction(app, reference, { status: 'succeeded' });

    expect(await gatewayOf(app).refresh(attemptId)).toEqual({ status: 'succeeded' });
    expect(await gatewayOf(app).refresh(attemptId)).toEqual({ status: 'succeeded' });

    expect(published.succeeded.filter((e) => e.attemptId === attemptId)).toHaveLength(1);
  });

  it('refuse la simulation (404) quand le sandbox est désactivé', async () => {
    const disabled = await createPaymentsApp({ env: { PAYMENTS_SANDBOX_ENABLED: 'false' } });
    try {
      await http(disabled).post(`${WEBHOOKS}/simulate`).send({}).expect(404);
      await http(disabled).post(`${WEBHOOKS}/sandbox/simulate`).send({ attemptId: randomUUID(), outcome: 'success' }).expect(404);
      await http(disabled).post(`${WEBHOOKS}/sandbox`).send({}).expect(404);
    } finally {
      await disabled.close();
    }
  });
});

describe('payments : limitation de débit des webhooks', () => {
  it('répond 429 au-delà de 120 notifications par minute et par IP', async () => {
    const app = await createPaymentsApp();
    try {
      for (let i = 0; i < 120; i += 1) await http(app).post(`${WEBHOOKS}/sandbox`).send({}).expect(401);

      await http(app).post(`${WEBHOOKS}/sandbox`).send({}).expect(429);
    } finally {
      await app.close();
    }
  });
});
