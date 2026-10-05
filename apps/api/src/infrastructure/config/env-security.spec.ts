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

describe('loadEnv : durcissement sécurité (valeurs par défaut)', () => {
  it('applique les défauts du contrat', () => {
    const env = loadEnv(BASE);

    expect(env.REDIS_URL).toBeUndefined();
    expect(env.RATE_LIMIT_STORE).toBe('memory');
    expect(env.RATE_LIMIT_KEY_PREFIX).toBe('ghmt:rl:');
    expect(env.SECURITY_JOBS_ENABLED).toBe(true);
  });

  it('traite REDIS_URL vide comme absente', () => {
    expect(loadEnv({ ...BASE, REDIS_URL: '' }).REDIS_URL).toBeUndefined();
  });
});

describe('loadEnv : Redis et limitation de débit', () => {
  it('accepte redis:// et rediss://, refuse les autres schémas', () => {
    expect(loadEnv({ ...BASE, REDIS_URL: 'redis://localhost:6379/0' }).REDIS_URL).toBe('redis://localhost:6379/0');
    expect(loadEnv({ ...BASE, REDIS_URL: 'rediss://cache.internal:6380' }).REDIS_URL).toBe('rediss://cache.internal:6380');
    expect(() => loadEnv({ ...BASE, REDIS_URL: 'http://localhost:6379' })).toThrow(/REDIS_URL/);
  });

  it('exige REDIS_URL avec RATE_LIMIT_STORE=redis', () => {
    expect(() => loadEnv({ ...BASE, RATE_LIMIT_STORE: 'redis' })).toThrow(/REDIS_URL/);
    expect(loadEnv({ ...BASE, RATE_LIMIT_STORE: 'redis', REDIS_URL: 'redis://localhost:6379' }).RATE_LIMIT_STORE).toBe('redis');
    expect(() => loadEnv({ ...BASE, RATE_LIMIT_STORE: 'disk' })).toThrow(/RATE_LIMIT_STORE/);
  });

  it('impose redis en production', () => {
    expect(() => loadEnv(PRODUCTION)).toThrow(/RATE_LIMIT_STORE=redis est obligatoire/);
    expect(() => loadEnv({ ...PRODUCTION, RATE_LIMIT_STORE: 'memory' })).toThrow(/RATE_LIMIT_STORE=redis est obligatoire/);
    expect(loadEnv({ ...PRODUCTION, RATE_LIMIT_STORE: 'redis', REDIS_URL: 'rediss://cache:6380' }).RATE_LIMIT_STORE).toBe('redis');
  });

  it('valide le préfixe des clés', () => {
    expect(loadEnv({ ...BASE, RATE_LIMIT_KEY_PREFIX: 'test:run-1:' }).RATE_LIMIT_KEY_PREFIX).toBe('test:run-1:');
    expect(() => loadEnv({ ...BASE, RATE_LIMIT_KEY_PREFIX: 'Majuscules' })).toThrow(/RATE_LIMIT_KEY_PREFIX/);
    expect(() => loadEnv({ ...BASE, RATE_LIMIT_KEY_PREFIX: 'x'.repeat(33) })).toThrow(/RATE_LIMIT_KEY_PREFIX/);
  });
});

describe('loadEnv : jobs de sécurité', () => {
  it('désactive les jobs avec SECURITY_JOBS_ENABLED=false et refuse les autres valeurs', () => {
    expect(loadEnv({ ...BASE, SECURITY_JOBS_ENABLED: 'false' }).SECURITY_JOBS_ENABLED).toBe(false);
    expect(() => loadEnv({ ...BASE, SECURITY_JOBS_ENABLED: 'oui' })).toThrow(/SECURITY_JOBS_ENABLED/);
  });
});
