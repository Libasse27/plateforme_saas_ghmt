import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hmacSha256Hex } from '../../src/modules/payments/domain/webhook-signature';
import { createTenantFixture, type TenantFixture } from '../helpers/fixtures';
import { WEBHOOKS, attemptRow, createPaymentsApp, eventRows, gatewayOf, http, initiateInput, recordPaymentEvents, type PublishedEvents } from './payments-fixtures';

const SECRET = 'secret-cinetpay-e2e';
const SITE_ID = '105888';
const CINETPAY_ENV = {
  CINETPAY_API_KEY: 'cle-api-e2e',
  CINETPAY_SITE_ID: SITE_ID,
  CINETPAY_SECRET_KEY: SECRET,
  CINETPAY_NOTIFY_URL: 'https://api.ghmt.test/api/v1/webhooks/payments/cinetpay',
};

const FIELD_ORDER = [
  'cpm_site_id', 'cpm_trans_id', 'cpm_trans_date', 'cpm_amount', 'cpm_currency', 'signature', 'payment_method',
  'cel_phone_num', 'cpm_phone_prefixe', 'cpm_language', 'cpm_version', 'cpm_payment_config', 'cpm_page_action',
  'cpm_custom', 'cpm_designation', 'cpm_error_message',
];

function notification(): Record<string, string> {
  return Object.fromEntries(FIELD_ORDER.map((name) => [name, '']));
}

function signedNotification(reference: string): { fields: Record<string, string>; token: string } {
  const fields: Record<string, string> = { ...notification(), cpm_site_id: SITE_ID, cpm_trans_id: reference, cpm_amount: '15000', cpm_currency: 'XOF', cpm_error_message: 'SUCCES' };
  return { fields, token: hmacSha256Hex(SECRET, FIELD_ORDER.map((name) => fields[name]).join('')) };
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('payments : adaptateur CinetPay de bout en bout (fetch simulé)', () => {
  let app: INestApplication;
  let tenant: TenantFixture;
  let published: PublishedEvents;
  const fetchMock = vi.fn();

  beforeAll(async () => {
    app = await createPaymentsApp({
      env: { ...CINETPAY_ENV, PAYMENTS_ROUTES: '{"*":["cinetpay","sandbox"]}' },
      fetch: fetchMock as unknown as typeof fetch,
    });
    tenant = await createTenantFixture(app);
    published = recordPaymentEvents(app);
  });

  beforeEach(() => {
    fetchMock.mockReset();
  });

  afterAll(async () => {
    await app?.close();
  });

  async function initiateOnCinetPay(): Promise<{ attemptId: string; reference: string }> {
    fetchMock.mockResolvedValueOnce(json({ code: '201', message: 'CREATED', data: { payment_url: 'https://checkout.cinetpay.com/payment/xyz', payment_token: 'xyz' } }));
    const result = await gatewayOf(app).initiate(initiateInput(tenant.tenantId));
    expect(result).toMatchObject({ provider: 'cinetpay', checkoutUrl: 'https://checkout.cinetpay.com/payment/xyz' });
    return { attemptId: result.attemptId, reference: (await attemptRow(app, result.attemptId)).providerReference as string };
  }

  const checkAccepted = (amount = '15000', currency = 'XOF'): void => {
    fetchMock.mockResolvedValueOnce(json({ code: '00', message: 'SUCCES', data: { status: 'ACCEPTED', amount, currency } }));
  };

  it('crée le paiement chez CinetPay avec la référence de la tentative et sans exposer le numéro', async () => {
    const { reference } = await initiateOnCinetPay();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api-checkout.cinetpay.com/v2/payment');
    expect(JSON.parse(String(init.body))).toMatchObject({ transaction_id: reference, amount: 15000, currency: 'XOF', customer_phone_number: '+221771234567' });
  });

  it('accepte une notification x-www-form-urlencoded signée, re-vérifie via /payment/check puis règle la tentative', async () => {
    const { attemptId, reference } = await initiateOnCinetPay();
    checkAccepted();
    const { fields, token } = signedNotification(reference);

    const res = await http(app).post(`${WEBHOOKS}/cinetpay`).set('x-token', token).type('form').send(fields).expect(200);

    expect(res.body.data.outcome).toBe('succeeded');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://api-checkout.cinetpay.com/v2/payment/check');
    expect((await attemptRow(app, attemptId)).status).toBe('succeeded');
    expect(published.succeeded.filter((e) => e.attemptId === attemptId)).toHaveLength(1);
  });

  it('accepte la même notification en JSON et dédoublonne son rejeu exact', async () => {
    const { attemptId, reference } = await initiateOnCinetPay();
    checkAccepted();
    const { fields, token } = signedNotification(reference);

    await http(app).post(`${WEBHOOKS}/cinetpay`).set('x-token', token).send(fields).expect(200);
    const replay = await http(app).post(`${WEBHOOKS}/cinetpay`).set('x-token', token).send(fields).expect(200);

    expect(replay.body.data.outcome).toBe('duplicate');
    expect(await eventRows(app, attemptId)).toHaveLength(1);
    expect(published.succeeded.filter((e) => e.attemptId === attemptId)).toHaveLength(1);
  });

  it('rejette (401) un jeton x-token faux sans appeler l’API de statut', async () => {
    const { attemptId, reference } = await initiateOnCinetPay();
    const { fields } = signedNotification(reference);

    await http(app).post(`${WEBHOOKS}/cinetpay`).set('x-token', 'f'.repeat(64)).send(fields).expect(401);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await attemptRow(app, attemptId)).status).toBe('pending');
  });

  it('ne crédite pas un montant ou une devise différents de ceux de la tentative', async () => {
    const { attemptId, reference } = await initiateOnCinetPay();
    checkAccepted('100');
    const { fields, token } = signedNotification(reference);

    await http(app).post(`${WEBHOOKS}/cinetpay`).set('x-token', token).send(fields).expect(200);

    expect((await attemptRow(app, attemptId)).failureReason).toBe('amount_mismatch');
    expect(published.succeeded.some((e) => e.attemptId === attemptId)).toBe(false);
  });

  it('répond 502 si l’API de statut est injoignable puis règle la tentative au rejeu du même webhook', async () => {
    const { attemptId, reference } = await initiateOnCinetPay();
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const { fields, token } = signedNotification(reference);

    await http(app).post(`${WEBHOOKS}/cinetpay`).set('x-token', token).send(fields).expect(502);
    expect((await attemptRow(app, attemptId)).status).toBe('pending');

    checkAccepted();
    await http(app).post(`${WEBHOOKS}/cinetpay`).set('x-token', token).send(fields).expect(200);

    expect((await attemptRow(app, attemptId)).status).toBe('succeeded');
  });

  it('retombe sur le sandbox quand CinetPay refuse la création', async () => {
    fetchMock.mockResolvedValueOnce(json({ code: '-1', message: 'INVALID_PARAMS' }, 400));

    const result = await gatewayOf(app).initiate(initiateInput(tenant.tenantId));

    expect(result.provider).toBe('sandbox');
    expect((await attemptRow(app, result.attemptId)).provider).toBe('sandbox');
  });

  it('refresh interroge CinetPay et règle une tentative dont le webhook est perdu', async () => {
    const { attemptId } = await initiateOnCinetPay();
    checkAccepted();

    expect(await gatewayOf(app).refresh(attemptId)).toEqual({ status: 'succeeded' });
  });

  it('refresh répond 502 quand l’agrégateur est injoignable', async () => {
    const { attemptId } = await initiateOnCinetPay();
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

    await expect(gatewayOf(app).refresh(attemptId)).rejects.toMatchObject({ status: 502, code: 'payment_provider_unavailable' });
  });
});

describe('payments : aucun fournisseur ne répond', () => {
  it('marque la tentative en échec et répond 502', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const app = await createPaymentsApp({
      env: { ...CINETPAY_ENV, PAYMENTS_ROUTES: '{"*":["cinetpay"]}' },
      fetch: fetchMock as unknown as typeof fetch,
    });
    try {
      const tenant = await createTenantFixture(app);
      const input = initiateInput(tenant.tenantId);

      await expect(gatewayOf(app).initiate(input)).rejects.toMatchObject({ status: 502 });

      const replayed = await gatewayOf(app).initiate(input);
      expect((await attemptRow(app, replayed.attemptId)).failureReason).toBe('provider_unavailable');
      expect(replayed.status).toBe('failed');
    } finally {
      await app.close();
    }
  });
});
