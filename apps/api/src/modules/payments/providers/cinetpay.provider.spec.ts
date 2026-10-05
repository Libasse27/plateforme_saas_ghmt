import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../infrastructure/config/env';
import { hmacSha256Hex } from '../domain/webhook-signature';
import { CinetPayProvider } from './cinetpay.provider';

const SECRET = 'secret-cinetpay-de-test';
const CONFIG = {
  CINETPAY_API_KEY: 'cle-api',
  CINETPAY_SITE_ID: '105888',
  CINETPAY_SECRET_KEY: SECRET,
  CINETPAY_BASE_URL: 'https://api-checkout.cinetpay.com/v2',
  CINETPAY_NOTIFY_URL: 'https://api.ghmt.test/api/v1/webhooks/payments/cinetpay',
  CINETPAY_RETURN_URL: 'https://app.ghmt.test/paiement/retour',
} as unknown as Env;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function provider(fetchImpl: typeof fetch, env: Env = CONFIG): CinetPayProvider {
  return new CinetPayProvider(env, fetchImpl);
}

const NOTIFICATION = {
  cpm_site_id: '105888',
  cpm_trans_id: 'GH0123456789abcdef012345',
  cpm_trans_date: '2026-10-05 10:00:00',
  cpm_amount: '15000',
  cpm_currency: 'XOF',
  signature: 'sig-cinetpay',
  payment_method: 'OM',
  cel_phone_num: '771234567',
  cpm_phone_prefixe: '221',
  cpm_language: 'fr',
  cpm_version: 'V2',
  cpm_payment_config: 'SINGLE',
  cpm_page_action: 'PAYMENT',
  cpm_custom: '',
  cpm_designation: 'Facture',
  cpm_error_message: 'SUCCES',
};

function tokenOf(fields: Record<string, string>): string {
  const order = [
    'cpm_site_id', 'cpm_trans_id', 'cpm_trans_date', 'cpm_amount', 'cpm_currency', 'signature', 'payment_method',
    'cel_phone_num', 'cpm_phone_prefixe', 'cpm_language', 'cpm_version', 'cpm_payment_config', 'cpm_page_action',
    'cpm_custom', 'cpm_designation', 'cpm_error_message',
  ];
  return hmacSha256Hex(SECRET, order.map((k) => fields[k] ?? '').join(''));
}

describe('CinetPayProvider : activation', () => {
  it('reste inactif tant que la configuration est incomplète', () => {
    const incomplete = { ...CONFIG, CINETPAY_SECRET_KEY: undefined } as unknown as Env;

    expect(provider(vi.fn(), incomplete).isEnabled()).toBe(false);
    expect(provider(vi.fn()).isEnabled()).toBe(true);
  });

  it('ne prend en charge que le Mobile Money dans les devises de l’agrégateur', () => {
    const p = provider(vi.fn());

    expect(p.supports('mobile_money', 'XOF')).toBe(true);
    expect(p.supports('mobile_money', 'EUR')).toBe(false);
    expect(p.supports('card', 'XOF')).toBe(false);
  });
});

describe('CinetPayProvider : création du paiement', () => {
  const input = {
    providerReference: 'GH0123456789abcdef012345',
    amount: '15000.00',
    currency: 'XOF',
    channel: 'mobile_money' as const,
    description: 'Facture #FAC_2026/000123',
    payerPhone: '+221771234567',
  };

  it('appelle /payment avec le montant entier, le canal et l’URL de notification, et renvoie l’URL de paiement', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ code: '201', message: 'CREATED', data: { payment_url: 'https://checkout.cinetpay.com/payment/abc', payment_token: 'abc' } }, 200));

    const session = await provider(fetchMock).createCheckout(input);

    expect(session.checkoutUrl).toBe('https://checkout.cinetpay.com/payment/abc');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api-checkout.cinetpay.com/v2/payment');
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      apikey: 'cle-api',
      site_id: '105888',
      transaction_id: 'GH0123456789abcdef012345',
      amount: 15000,
      currency: 'XOF',
      channels: 'MOBILE_MONEY',
      notify_url: CONFIG.CINETPAY_NOTIFY_URL,
      customer_phone_number: '+221771234567',
    });
    // Les caractères interdits par CinetPay (# / $ _ &) sont retirés du libellé.
    expect(body['description']).toBe('Facture FAC2026000123');
  });

  it('refuse un montant avec décimales en XOF avant tout appel réseau', async () => {
    const fetchMock = vi.fn();

    await expect(provider(fetchMock).createCheckout({ ...input, amount: '15000.50' })).rejects.toThrow(/entier/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lève une ProviderError sans fuite de secret sur un refus de l’agrégateur', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ code: '-1', message: 'INVALID_PARAMS', description: 'apikey invalide' }, 400));

    const error = await provider(fetchMock).createCheckout(input).catch((e: unknown) => e);

    expect(error).toMatchObject({ name: 'ProviderError', provider: 'cinetpay' });
    expect((error as Error).message).not.toContain('cle-api');
  });

  it('lève une ProviderError sur une erreur réseau', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

    await expect(provider(fetchMock).createCheckout(input)).rejects.toMatchObject({ name: 'ProviderError' });
  });
});

describe('CinetPayProvider : re-vérification du statut', () => {
  const check = (body: unknown, status = 200): CinetPayProvider => provider(vi.fn().mockResolvedValue(jsonResponse(body, status)));

  it('interroge /payment/check avec la clé, le site et la référence', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ code: '00', data: { status: 'ACCEPTED', amount: '15000', currency: 'XOF' } }));

    await provider(fetchMock).getTransactionStatus('GHREF');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api-checkout.cinetpay.com/v2/payment/check');
    expect(JSON.parse(String(init.body))).toEqual({ apikey: 'cle-api', site_id: '105888', transaction_id: 'GHREF' });
  });

  it('traduit ACCEPTED en succès avec le montant et la devise constatés', async () => {
    await expect(check({ code: '00', data: { status: 'ACCEPTED', amount: '15000', currency: 'XOF' } }).getTransactionStatus('R')).resolves.toEqual({
      status: 'succeeded',
      amount: '15000',
      currency: 'XOF',
    });
  });

  it('traduit REFUSED et l’annulation en échec', async () => {
    await expect(check({ code: '600', data: { status: 'REFUSED', amount: '15000', currency: 'XOF' } }).getTransactionStatus('R')).resolves.toMatchObject({ status: 'failed' });
    await expect(check({ code: '627', message: 'TRANSACTION_CANCEL' }).getTransactionStatus('R')).resolves.toMatchObject({ status: 'failed' });
  });

  it('traduit l’attente du client et une transaction encore inconnue en attente', async () => {
    await expect(check({ code: '662', message: 'WAITING_CUSTOMER_PAYMENT', data: { status: 'WAITING_FOR_CUSTOMER' } }).getTransactionStatus('R')).resolves.toMatchObject({ status: 'pending' });
    await expect(check({ code: '625', message: 'TRANSACTION_NOT_FOUND' }, 404).getTransactionStatus('R')).resolves.toMatchObject({ status: 'pending' });
  });

  it('lève une ProviderError sur une réponse inattendue ou un statut HTTP 5xx', async () => {
    await expect(check({ nimporte: 'quoi' }).getTransactionStatus('R')).rejects.toMatchObject({ name: 'ProviderError' });
    await expect(check({}, 503).getTransactionStatus('R')).rejects.toMatchObject({ name: 'ProviderError' });
  });
});

describe('CinetPayProvider : signature du webhook', () => {
  const p = provider(vi.fn());
  const json = (fields: Record<string, string>): Buffer => Buffer.from(JSON.stringify(fields));

  it('accepte un webhook JSON dont le jeton HMAC (en-tête x-token) est valide', () => {
    const result = p.verifyWebhook({ 'x-token': tokenOf(NOTIFICATION) }, json(NOTIFICATION));

    expect(result).toMatchObject({ valid: true, providerReference: 'GH0123456789abcdef012345' });
    expect(result.valid && result.eventId).toContain('GH0123456789abcdef012345');
  });

  it('accepte un webhook en application/x-www-form-urlencoded', () => {
    const body = Buffer.from(new URLSearchParams(NOTIFICATION).toString());

    expect(p.verifyWebhook({ 'x-token': tokenOf(NOTIFICATION) }, body).valid).toBe(true);
  });

  it('refuse un jeton absent, falsifié ou calculé avec un autre secret', () => {
    expect(p.verifyWebhook({}, json(NOTIFICATION)).valid).toBe(false);
    expect(p.verifyWebhook({ 'x-token': 'a'.repeat(64) }, json(NOTIFICATION)).valid).toBe(false);
    expect(p.verifyWebhook({ 'x-token': hmacSha256Hex('autre', 'x') }, json(NOTIFICATION)).valid).toBe(false);
  });

  it('refuse un corps modifié après signature (montant altéré)', () => {
    const token = tokenOf(NOTIFICATION);

    expect(p.verifyWebhook({ 'x-token': token }, json({ ...NOTIFICATION, cpm_amount: '1' })).valid).toBe(false);
  });

  it('refuse un webhook destiné à un autre site, un corps illisible ou sans référence', () => {
    const other = { ...NOTIFICATION, cpm_site_id: '999' };
    expect(p.verifyWebhook({ 'x-token': tokenOf(other) }, json(other)).valid).toBe(false);
    expect(p.verifyWebhook({ 'x-token': 'abc' }, Buffer.from('{pas du json'.repeat(2))).valid).toBe(false);
    const noRef = { ...NOTIFICATION, cpm_trans_id: '' };
    expect(p.verifyWebhook({ 'x-token': tokenOf(noRef) }, json(noRef)).valid).toBe(false);
  });
});
