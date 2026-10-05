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
const PRODUCTION = { ...BASE, NODE_ENV: 'production', TRUSTED_PROXIES: '10.0.0.0/8', JWT_PLATFORM_SECRET: 'p'.repeat(40) };

describe('loadEnv : notifications (valeurs par défaut)', () => {
  it('applique les défauts du contrat', () => {
    const env = loadEnv(BASE);

    expect(env.NOTIFICATIONS_WORKER_ENABLED).toBe(true);
    expect(env.NOTIFICATIONS_DISPATCH_INTERVAL_MS).toBe(10_000);
    expect(env.NOTIFICATIONS_BATCH_SIZE).toBe(50);
    expect(env.SMS_PROVIDER).toBe('none');
    expect(env.SMS_SANDBOX_MAILBOX).toBe('sms-sandbox@ghmt.local');
    expect(env.SMS_HTTP_SENDER_ID).toBe('GHMT');
    expect(env.SMS_HTTP_TIMEOUT_MS).toBe(10_000);
    expect(env.SMS_HTTP_URL).toBeUndefined();
    expect(env.SAAS_DUNNING_OFFSETS_DAYS).toEqual([-7, -3, 0, 3, 7, 12, 15]);
  });

  it('traite les variables vides du modèle .env.example comme absentes', () => {
    const env = loadEnv({ ...BASE, SMS_HTTP_URL: '', SMS_HTTP_TOKEN: '', SMS_HTTP_WEBHOOK_SECRET: '' });

    expect(env.SMS_HTTP_URL).toBeUndefined();
    expect(env.SMS_HTTP_TOKEN).toBeUndefined();
    expect(env.SMS_HTTP_WEBHOOK_SECRET).toBeUndefined();
  });
});

describe('loadEnv : worker et intervalles', () => {
  it('désactive le worker avec NOTIFICATIONS_WORKER_ENABLED=false', () => {
    expect(loadEnv({ ...BASE, NOTIFICATIONS_WORKER_ENABLED: 'false' }).NOTIFICATIONS_WORKER_ENABLED).toBe(false);
    expect(() => loadEnv({ ...BASE, NOTIFICATIONS_WORKER_ENABLED: 'oui' })).toThrow(/NOTIFICATIONS_WORKER_ENABLED/);
  });

  it('borne l’intervalle (2 000..300 000 ms) et le lot (1..500)', () => {
    expect(() => loadEnv({ ...BASE, NOTIFICATIONS_DISPATCH_INTERVAL_MS: '1999' })).toThrow(/NOTIFICATIONS_DISPATCH_INTERVAL_MS/);
    expect(() => loadEnv({ ...BASE, NOTIFICATIONS_DISPATCH_INTERVAL_MS: '300001' })).toThrow(/NOTIFICATIONS_DISPATCH_INTERVAL_MS/);
    expect(loadEnv({ ...BASE, NOTIFICATIONS_DISPATCH_INTERVAL_MS: '2000' }).NOTIFICATIONS_DISPATCH_INTERVAL_MS).toBe(2000);
    expect(() => loadEnv({ ...BASE, NOTIFICATIONS_BATCH_SIZE: '0' })).toThrow(/NOTIFICATIONS_BATCH_SIZE/);
    expect(() => loadEnv({ ...BASE, NOTIFICATIONS_BATCH_SIZE: '501' })).toThrow(/NOTIFICATIONS_BATCH_SIZE/);
  });
});

describe('loadEnv : fournisseur SMS', () => {
  const HTTP = { SMS_PROVIDER: 'http', SMS_HTTP_URL: 'https://sms.example.com/send', SMS_HTTP_TOKEN: 't'.repeat(16) };

  it('refuse un fournisseur inconnu', () => {
    expect(() => loadEnv({ ...BASE, SMS_PROVIDER: 'twilio' })).toThrow(/SMS_PROVIDER/);
  });

  it('interdit le sandbox en production et l’autorise ailleurs', () => {
    expect(loadEnv({ ...BASE, SMS_PROVIDER: 'sandbox' }).SMS_PROVIDER).toBe('sandbox');
    expect(() => loadEnv({ ...PRODUCTION, SMS_PROVIDER: 'sandbox' })).toThrow(/SMS_PROVIDER/);
    expect(loadEnv(PRODUCTION).SMS_PROVIDER).toBe('none');
  });

  it('refuse l’adaptateur http sans URL ou sans jeton', () => {
    expect(() => loadEnv({ ...BASE, SMS_PROVIDER: 'http' })).toThrow(/SMS_HTTP_URL/);
    expect(() => loadEnv({ ...BASE, ...HTTP, SMS_HTTP_TOKEN: undefined })).toThrow(/SMS_HTTP_TOKEN/);
    expect(loadEnv({ ...BASE, ...HTTP }).SMS_PROVIDER).toBe('http');
  });

  it('exige un jeton d’au moins 16 caractères et un secret de webhook d’au moins 32', () => {
    expect(() => loadEnv({ ...BASE, ...HTTP, SMS_HTTP_TOKEN: 'court' })).toThrow(/SMS_HTTP_TOKEN/);
    expect(() => loadEnv({ ...BASE, SMS_HTTP_WEBHOOK_SECRET: 'court' })).toThrow(/SMS_HTTP_WEBHOOK_SECRET/);
    expect(loadEnv({ ...BASE, SMS_HTTP_WEBHOOK_SECRET: 's'.repeat(32) }).SMS_HTTP_WEBHOOK_SECRET).toHaveLength(32);
  });

  it('tolère http:// hors production mais l’exige en https en production', () => {
    const insecure = { ...HTTP, SMS_HTTP_URL: 'http://localhost:9999/send' };
    expect(loadEnv({ ...BASE, ...insecure }).SMS_HTTP_URL).toBe('http://localhost:9999/send');
    expect(() => loadEnv({ ...PRODUCTION, ...insecure })).toThrow(/SMS_HTTP_URL/);
    expect(loadEnv({ ...PRODUCTION, ...HTTP }).SMS_PROVIDER).toBe('http');
  });

  it('valide l’identifiant d’expéditeur et le délai', () => {
    expect(() => loadEnv({ ...BASE, SMS_HTTP_SENDER_ID: 'AB' })).toThrow(/SMS_HTTP_SENDER_ID/);
    expect(() => loadEnv({ ...BASE, SMS_HTTP_SENDER_ID: 'Clinique-Awa' })).toThrow(/SMS_HTTP_SENDER_ID/);
    expect(loadEnv({ ...BASE, SMS_HTTP_SENDER_ID: 'Awa123' }).SMS_HTTP_SENDER_ID).toBe('Awa123');
    expect(() => loadEnv({ ...BASE, SMS_HTTP_TIMEOUT_MS: '999' })).toThrow(/SMS_HTTP_TIMEOUT_MS/);
    expect(() => loadEnv({ ...BASE, SMS_HTTP_TIMEOUT_MS: '30001' })).toThrow(/SMS_HTTP_TIMEOUT_MS/);
  });
});

describe('loadEnv : calendrier des relances SaaS', () => {
  it('analyse une liste d’entiers triée et sans doublon', () => {
    expect(loadEnv({ ...BASE, SAAS_DUNNING_OFFSETS_DAYS: '-3, 0,5' }).SAAS_DUNNING_OFFSETS_DAYS).toEqual([-3, 0, 5]);
  });

  it.each(['', '  ', 'a,b', '0,0', '3,0', '-31,0', '0,61', '1.5'])('refuse la liste invalide « %s » quand elle est fournie', (value) => {
    if (value.trim() === '') {
      expect(loadEnv({ ...BASE, SAAS_DUNNING_OFFSETS_DAYS: value }).SAAS_DUNNING_OFFSETS_DAYS).toEqual([-7, -3, 0, 3, 7, 12, 15]);
      return;
    }
    expect(() => loadEnv({ ...BASE, SAAS_DUNNING_OFFSETS_DAYS: value })).toThrow(/SAAS_DUNNING_OFFSETS_DAYS/);
  });
});
