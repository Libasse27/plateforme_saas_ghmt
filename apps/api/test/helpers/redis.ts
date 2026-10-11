import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Redis } from 'ioredis';
import { ENV, loadEnv, type Env } from '../../src/infrastructure/config/env';
import { createTestApp, type ProviderOverride } from './test-app';

export const TEST_REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379/15';

/** Préfixe de clés unique par exécution : deux exécutions parallèles ou successives ne partagent jamais de compteur. */
export const uniqueKeyPrefix = (): string => `test${randomBytes(4).toString('hex')}:`;

/** Remplace `ENV` par une configuration à stockage Redis. Un objet distinct par application : chacune ouvre son propre client. */
export function redisEnvOverride(prefix: string, url: string = TEST_REDIS_URL): ProviderOverride {
  const env: Env = { ...loadEnv(), RATE_LIMIT_STORE: 'redis', REDIS_URL: url, RATE_LIMIT_KEY_PREFIX: prefix };
  return { token: ENV, useValue: env };
}

export function createRedisApp(prefix: string, url?: string): Promise<INestApplication> {
  return createTestApp({}, { providerOverrides: [redisEnvOverride(prefix, url)] });
}

/** Indique si Redis répond (la spec dédiée est ignorée sinon, avec un message explicite). */
export async function redisAvailable(url: string = TEST_REDIS_URL): Promise<boolean> {
  const client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
  client.on('error', () => undefined);
  try {
    await client.connect();
    return (await client.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    client.disconnect();
  }
}

/** Supprime les clés d'un préfixe de test. */
export async function purgePrefix(prefix: string, url: string = TEST_REDIS_URL): Promise<void> {
  const client = new Redis(url);
  try {
    const keys = await client.keys(`${prefix}*`);
    if (keys.length > 0) await client.del(...keys);
  } finally {
    client.disconnect();
  }
}
