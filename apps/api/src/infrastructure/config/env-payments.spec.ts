import { describe, expect, it } from 'vitest';
import { loadEnv } from './env';

const BASE = {
  DATABASE_URL: 'postgresql://ghmt_app:x@localhost:5432/ghmt_test',
  PLATFORM_DATABASE_URL: 'postgresql://ghmt_platform:x@localhost:5432/ghmt_test',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
  JWT_ISSUER: 'https://api.ghmt.local',
  JWT_AUDIENCE: 'ghmt-api',
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  BLIND_INDEX_KEY: Buffer.alloc(32, 2).toString('base64'),
};

describe('loadEnv : paiements', () => {
  it('active le sandbox par défaut hors production et laisse CinetPay inactif', () => {
    const env = loadEnv(BASE);

    expect(env.PAYMENTS_SANDBOX_ENABLED).toBe(true);
    expect(env.CINETPAY_API_KEY).toBeUndefined();
    expect(env.CINETPAY_BASE_URL).toBe('https://api-checkout.cinetpay.com/v2');
    expect(env.PAYMENTS_ROUTES).toEqual({});
  });

  it('traite une variable CinetPay vide comme absente (modèle .env.example)', () => {
    const env = loadEnv({ ...BASE, CINETPAY_API_KEY: '', CINETPAY_SITE_ID: '', CINETPAY_SECRET_KEY: '' });

    expect(env.CINETPAY_API_KEY).toBeUndefined();
    expect(env.CINETPAY_SITE_ID).toBeUndefined();
  });

  it('désactive le sandbox en production par défaut et refuse de l’activer explicitement', () => {
    const production = { ...BASE, NODE_ENV: 'production', TRUSTED_PROXIES: '10.0.0.0/8' };

    expect(loadEnv(production).PAYMENTS_SANDBOX_ENABLED).toBe(false);
    expect(() => loadEnv({ ...production, PAYMENTS_SANDBOX_ENABLED: 'true' })).toThrow(/PAYMENTS_SANDBOX_ENABLED/);
  });

  it('permet de désactiver le sandbox hors production', () => {
    expect(loadEnv({ ...BASE, PAYMENTS_SANDBOX_ENABLED: 'false' }).PAYMENTS_SANDBOX_ENABLED).toBe(false);
  });

  it('lit le routage JSON par pays/devise et refuse un JSON invalide', () => {
    const env = loadEnv({ ...BASE, PAYMENTS_ROUTES: '{"SN:XOF":["cinetpay","sandbox"],"*":["sandbox"]}' });

    expect(env.PAYMENTS_ROUTES).toEqual({ 'SN:XOF': ['cinetpay', 'sandbox'], '*': ['sandbox'] });
    expect(() => loadEnv({ ...BASE, PAYMENTS_ROUTES: '{pas du json' })).toThrow(/PAYMENTS_ROUTES/);
    expect(() => loadEnv({ ...BASE, PAYMENTS_ROUTES: '{"XOF":"cinetpay"}' })).toThrow(/PAYMENTS_ROUTES/);
  });

  it('refuse une URL CinetPay invalide', () => {
    expect(() => loadEnv({ ...BASE, CINETPAY_BASE_URL: 'pas-une-url' })).toThrow(/CINETPAY_BASE_URL/);
  });
});
