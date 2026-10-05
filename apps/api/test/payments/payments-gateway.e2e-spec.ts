import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTenantFixture, type TenantFixture } from '../helpers/fixtures';
import { attemptRow, createPaymentsApp, gatewayOf, initiateInput } from './payments-fixtures';

describe('payments : initiation via PAYMENTS_GATEWAY (sandbox)', () => {
  let app: INestApplication;
  let tenant: TenantFixture;

  beforeAll(async () => {
    app = await createPaymentsApp();
    tenant = await createTenantFixture(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('crée une tentative en attente avec une URL de paiement simulée', async () => {
    const result = await gatewayOf(app).initiate(initiateInput(tenant.tenantId));

    expect(result).toMatchObject({ status: 'pending', provider: 'sandbox' });
    expect(result.checkoutUrl).toContain('/');
    const row = await attemptRow(app, result.attemptId);
    expect(row.amount.toFixed(2)).toBe('15000.00');
    expect(row.currency).toBe('XOF');
    expect(row.providerReference).toMatch(/^GH[0-9a-f]{22}$/);
  });

  it('ne conserve jamais le numéro du payeur en clair (empreinte HMAC uniquement)', async () => {
    const result = await gatewayOf(app).initiate(initiateInput(tenant.tenantId, { payerPhone: '+221779998877' }));

    const row = await attemptRow(app, result.attemptId);
    expect(row.payerPhoneHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain('779998877');
  });

  it('renvoie la même tentative pour une même clé d’idempotence', async () => {
    const input = initiateInput(tenant.tenantId);

    const first = await gatewayOf(app).initiate(input);
    const second = await gatewayOf(app).initiate(input);

    expect(second.attemptId).toBe(first.attemptId);
    expect(second.checkoutUrl).toBe(first.checkoutUrl);
  });

  it('résiste à deux initiations simultanées avec la même clé (une seule tentative)', async () => {
    const input = initiateInput(tenant.tenantId);

    const results = await Promise.all([gatewayOf(app).initiate(input), gatewayOf(app).initiate(input), gatewayOf(app).initiate(input)]);

    expect(new Set(results.map((r) => r.attemptId)).size).toBe(1);
  });

  it('refuse (409) la réutilisation d’une clé d’idempotence pour une autre demande', async () => {
    const input = initiateInput(tenant.tenantId);
    await gatewayOf(app).initiate(input);

    await expect(gatewayOf(app).initiate({ ...input, amount: '999.00' })).rejects.toMatchObject({ status: 409, code: 'idempotency_key_reused' });
  });

  it.each([
    ['montant non décimal', { amount: '15000,5' }],
    ['montant nul', { amount: '0.00' }],
    ['montant à 3 décimales', { amount: '10.123' }],
    ['devise invalide', { currency: 'xof' }],
    ['clé d’idempotence trop courte', { idempotencyKey: 'abc' }],
    ['libellé vide', { description: '' }],
    ['téléphone non E.164', { payerPhone: '0771234567' }],
  ])('refuse en 422 : %s', async (_label, overrides) => {
    await expect(gatewayOf(app).initiate(initiateInput(tenant.tenantId, overrides))).rejects.toMatchObject({ status: 422 });
  });

  it('refuse une référence ou un tenant qui ne sont pas des UUID', async () => {
    await expect(gatewayOf(app).initiate(initiateInput('pas-un-uuid'))).rejects.toMatchObject({ status: 422 });
    await expect(gatewayOf(app).initiate(initiateInput(tenant.tenantId, { referenceId: 'x' }))).rejects.toMatchObject({ status: 422 });
  });

  it('refresh d’une tentative inconnue ⇒ 404', async () => {
    await expect(gatewayOf(app).refresh('0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b')).rejects.toMatchObject({ status: 404 });
  });
});

describe('payments : routage et fournisseurs inactifs', () => {
  it('répond 503 quand aucun fournisseur actif ne couvre la demande (sandbox désactivé, CinetPay non configuré)', async () => {
    const app = await createPaymentsApp({ env: { PAYMENTS_SANDBOX_ENABLED: 'false' } });
    try {
      const tenant = await createTenantFixture(app);

      await expect(gatewayOf(app).initiate(initiateInput(tenant.tenantId))).rejects.toMatchObject({ status: 503, code: 'payment_provider_unavailable' });
    } finally {
      await app.close();
    }
  });

  it('retombe sur le fournisseur suivant quand le premier est inactif', async () => {
    const app = await createPaymentsApp({ env: { PAYMENTS_ROUTES: '{"*":["cinetpay","sandbox"]}' } });
    try {
      const tenant = await createTenantFixture(app);

      const result = await gatewayOf(app).initiate(initiateInput(tenant.tenantId));

      expect(result.provider).toBe('sandbox');
    } finally {
      await app.close();
    }
  });
});
