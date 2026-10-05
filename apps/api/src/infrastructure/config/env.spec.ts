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

describe('loadEnv : proxys de confiance, e-mail et URL web', () => {
  it('applique des valeurs de développement par défaut (loopback, Mailpit, web local)', () => {
    const env = loadEnv(BASE);

    expect(env.TRUSTED_PROXIES).toEqual(['loopback']);
    expect(env.WEB_URL).toBe('http://localhost:3001');
    expect(env.SMTP_HOST).toBe('localhost');
    expect(env.SMTP_PORT).toBe(1025);
    expect(env.MAIL_FROM).toContain('@');
  });

  it('découpe TRUSTED_PROXIES en liste de CIDR / mots-clés', () => {
    const env = loadEnv({ ...BASE, TRUSTED_PROXIES: ' 10.0.0.0/8 , loopback,,fd00::/8 ' });

    expect(env.TRUSTED_PROXIES).toEqual(['10.0.0.0/8', 'loopback', 'fd00::/8']);
  });

  it('refuse un WEB_URL invalide ou un port SMTP hors bornes', () => {
    expect(() => loadEnv({ ...BASE, WEB_URL: 'pas-une-url' })).toThrow(/Configuration invalide/);
    expect(() => loadEnv({ ...BASE, SMTP_PORT: '70000' })).toThrow(/SMTP_PORT/);
  });
});

describe('loadEnv : production', () => {
  it('refuse de démarrer en production sans TRUSTED_PROXIES explicite', () => {
    expect(() => loadEnv({ ...BASE, NODE_ENV: 'production' })).toThrow(/TRUSTED_PROXIES/);
  });

  it('accepte la production quand les proxys de confiance sont déclarés', () => {
    expect(loadEnv({ ...BASE, NODE_ENV: 'production', TRUSTED_PROXIES: '10.0.0.0/24', JWT_PLATFORM_SECRET: 'p'.repeat(40) }).TRUSTED_PROXIES).toEqual(['10.0.0.0/24']);
  });
});

describe('loadEnv : secret JWT du realm plateforme (L1)', () => {
  const PRODUCTION = { ...BASE, NODE_ENV: 'production', TRUSTED_PROXIES: '10.0.0.0/24' };

  it('dérive un secret distinct de JWT_ACCESS_SECRET hors production quand JWT_PLATFORM_SECRET est absent', () => {
    const env = loadEnv(BASE);

    expect(env.JWT_PLATFORM_SECRET.length).toBeGreaterThanOrEqual(32);
    expect(env.JWT_PLATFORM_SECRET).not.toBe(env.JWT_ACCESS_SECRET);
  });

  it('utilise JWT_PLATFORM_SECRET quand il est fourni', () => {
    expect(loadEnv({ ...BASE, JWT_PLATFORM_SECRET: 'p'.repeat(40) }).JWT_PLATFORM_SECRET).toBe('p'.repeat(40));
  });

  it('refuse un secret plateforme de moins de 32 caractères', () => {
    expect(() => loadEnv({ ...BASE, JWT_PLATFORM_SECRET: 'court' })).toThrow(/JWT_PLATFORM_SECRET/);
  });

  it('exige en production un secret plateforme défini et différent du secret tenant', () => {
    expect(() => loadEnv(PRODUCTION)).toThrow(/JWT_PLATFORM_SECRET/);
    expect(() => loadEnv({ ...PRODUCTION, JWT_PLATFORM_SECRET: BASE.JWT_ACCESS_SECRET })).toThrow(/distinct/);
    expect(loadEnv({ ...PRODUCTION, JWT_PLATFORM_SECRET: 'p'.repeat(40) }).JWT_PLATFORM_SECRET).toBe('p'.repeat(40));
  });
});
