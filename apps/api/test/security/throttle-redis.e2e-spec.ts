import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTH, distinctClientIp, http } from '../auth/auth-helpers';
import { createTenantFixture, type TenantFixture } from '../helpers/fixtures';
import { RedisRateLimitStore } from '../../src/common/rate-limit/redis-rate-limit-store';
import { TEST_REDIS_URL, createRedisApp, purgePrefix, redisAvailable, uniqueKeyPrefix } from '../helpers/redis';

const REDIS_UP = await redisAvailable();
const UNREACHABLE_REDIS = 'redis://127.0.0.1:6399';

describe.skipIf(!REDIS_UP)('limitation de débit sur Redis, deux instances (docs/11 D2)', () => {
  const prefix = uniqueKeyPrefix();
  let first: INestApplication;
  let second: INestApplication;
  let tenant: TenantFixture;

  const loginOn = (app: INestApplication, email: string, extra: Record<string, string> = {}) =>
    http(app).post(`${AUTH}/login`).set(extra).send({ tenantSlug: 'inconnu-redis', email, password: 'x' });

  beforeAll(async () => {
    [first, second] = await Promise.all([createRedisApp(prefix), createRedisApp(prefix)]);
    tenant = await createTenantFixture(first, { prefix: 'redis' });
  });

  afterAll(async () => {
    await Promise.all([first?.close(), second?.close()]);
    await purgePrefix(prefix);
  });

  it('partage le compteur par IP : la 21e tentative de login est refusée, instances confondues', async () => {
    for (let i = 0; i < 20; i += 1) await loginOn(i % 2 === 0 ? first : second, `ip${i}@b.test`).expect(401);

    const refusedOnFirst = await loginOn(first, 'ip20@b.test').expect(429);
    const refusedOnSecond = await loginOn(second, 'ip21@b.test').expect(429);

    expect(refusedOnFirst.body.code).toBe('rate_limited');
    expect(refusedOnSecond.body.code).toBe('rate_limited');
  });

  it('partage le délai progressif : 5 échecs répartis sur les deux instances ralentissent les deux', async () => {
    const email = tenant.adminEmail;
    for (let i = 0; i < 5; i += 1) {
      await http(i % 2 === 0 ? first : second)
        .post(`${AUTH}/login`)
        .set('X-Forwarded-For', distinctClientIp())
        .send({ tenantSlug: tenant.slug, email, password: 'mauvais-mot-de-passe' })
        .expect(401);
    }

    for (const app of [first, second]) {
      const res = await http(app)
        .post(`${AUTH}/login`)
        .set('X-Forwarded-For', distinctClientIp())
        .send({ tenantSlug: tenant.slug, email, password: 'mauvais-mot-de-passe' })
        .expect(429);
      expect(res.body.code).toBe('login_delayed');
    }
  });

  it('écrit les compteurs sous le préfixe configuré', async () => {
    const { Redis } = await import('ioredis');
    const client = new Redis(process.env['REDIS_URL'] ?? 'redis://localhost:6379/15');
    try {
      expect((await client.keys(`${prefix}*`)).length).toBeGreaterThan(0);
    } finally {
      client.disconnect();
    }
  });

  it('GET /health/ready indique redis « up » et une limitation partagée sur « redis » sur les deux instances', async () => {
    for (const app of [first, second]) {
      const res = await http(app).get('/api/v1/health/ready').expect(200);
      expect(res.body.data).toEqual({ status: 'ok', checks: { redis: 'up', rateLimit: 'redis' } });
    }
  });
});

describe.skipIf(!REDIS_UP)('délai progressif atomique sur Redis (script Lua, docs/11 §14.2)', () => {
  const prefix = uniqueKeyPrefix();
  const SCHEDULE = [0, 0, 0, 0, 30, 60, 120, 300, 600, 900];
  const TTL = 24 * 3_600_000;
  const T0 = 1_800_000_000_000;
  let client: import('ioredis').Redis;
  let store: RedisRateLimitStore;

  beforeAll(async () => {
    const { Redis } = await import('ioredis');
    client = new Redis(TEST_REDIS_URL);
    store = new RedisRateLimitStore(client, prefix);
  });

  afterAll(async () => {
    client?.disconnect();
    await purgePrefix(prefix);
  });

  it('une seule de dix tentatives simultanées franchit le palier du 5e échec', async () => {
    for (let i = 0; i < 4; i += 1) await store.gate('gate-a', TTL, T0, SCHEDULE, null);

    const results = await Promise.all(Array.from({ length: 10 }, () => store.gate('gate-a', TTL, T0, SCHEDULE, null)));

    expect(results.filter((r) => r.allowed)).toHaveLength(1);
    expect(await store.get('gate-a')).toEqual({ count: 5, lastAtMs: T0 });
  });

  it('plafonne le délai et rend la date du dernier échec avec la réservation', async () => {
    for (let i = 0; i < 8; i += 1) await store.gate('gate-b', TTL, T0, [0], null);

    expect((await store.gate('gate-b', TTL, T0, SCHEDULE, 60)).retryAfterMs).toBe(60_000);
    expect((await store.gate('gate-b', TTL, T0 + 61_000, SCHEDULE, 60)).allowed).toBe(true);
    await store.release('gate-b');

    expect(await store.get('gate-b')).toEqual({ count: 8, lastAtMs: T0 });
  });
});

describe('repli mémoire quand Redis est indisponible (docs/11 D2)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createRedisApp(uniqueKeyPrefix(), UNREACHABLE_REDIS);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('applique tout de même la limite par IP (jamais d’absence de limitation)', async () => {
    const attempt = (i: number) => http(app).post(`${AUTH}/login`).send({ tenantSlug: 'inconnu-redis', email: `down${i}@b.test`, password: 'x' });
    for (let i = 0; i < 20; i += 1) await attempt(i).expect(401);

    await attempt(20).expect(429);
  });

  it('signale redis « down » et le repli « memory_fallback » dans /health/ready sans faire échouer la sonde', async () => {
    const res = await http(app).get('/api/v1/health/ready').expect(200);

    expect(res.body.data).toEqual({ status: 'ok', checks: { redis: 'down', rateLimit: 'memory_fallback' } });
  });
});

describe('stockage mémoire (configuration des tests)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const { createTestApp } = await import('../helpers/test-app');
    app = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('signale redis « disabled » et une limitation « memory » dans /health/ready', async () => {
    const res = await http(app).get('/api/v1/health/ready').expect(200);

    expect(res.body.data.checks).toEqual({ redis: 'disabled', rateLimit: 'memory' });
  });

  it('GET /health public ne renvoie que { status } (docs/11 §14.2 M6)', async () => {
    const res = await http(app).get('/api/v1/health').expect(200);

    expect(res.body.data).toEqual({ status: 'ok' });
  });
});
