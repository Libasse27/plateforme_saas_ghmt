import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { MemoryRateLimitStore } from './common/rate-limit/memory-rate-limit-store';
import type { RateLimitStore } from './common/rate-limit/rate-limit-store';
import { ResilientRateLimitStore } from './common/rate-limit/resilient-rate-limit-store';
import { HealthController } from './health.controller';

const clientReplying = (reply: () => Promise<string>): Redis => ({ ping: reply }) as unknown as Redis;
const memoryStore = (): RateLimitStore => new MemoryRateLimitStore();
const brokenStore = (): RateLimitStore => {
  const fail = () => Promise.reject(new Error('redis indisponible'));
  return { hit: fail, gate: fail, release: fail, get: fail, reset: fail };
};

describe('HealthController.check (sonde publique)', () => {
  it('ne renvoie que { status } : aucun détail d’infrastructure exposé', async () => {
    const controller = new HealthController(clientReplying(() => Promise.reject(new Error('coupé'))), memoryStore());

    expect(await controller.check()).toEqual({ status: 'ok' });
  });
});

describe('HealthController.ready (sonde interne, non routée par le proxy)', () => {
  it('signale redis « disabled » et une limitation « memory » sans client (stockage mémoire configuré)', async () => {
    expect(await new HealthController(null, memoryStore()).ready()).toEqual({ status: 'ok', checks: { redis: 'disabled', rateLimit: 'memory' } });
  });

  it('signale redis « up » quand PING répond, et une limitation sur « redis »', async () => {
    const store = new ResilientRateLimitStore(memoryStore(), memoryStore());
    const controller = new HealthController(clientReplying(() => Promise.resolve('PONG')), store);
    expect(await controller.ready()).toEqual({ status: 'ok', checks: { redis: 'up', rateLimit: 'redis' } });
  });

  it('signale redis « down » sur erreur ou réponse inattendue, sans faire échouer la sonde', async () => {
    const store = new ResilientRateLimitStore(memoryStore(), memoryStore());
    expect((await new HealthController(clientReplying(() => Promise.reject(new Error('coupé'))), store).ready()).checks.redis).toBe('down');
    expect((await new HealthController(clientReplying(() => Promise.resolve('ERR')), store).ready()).checks.redis).toBe('down');
  });

  it('signale le repli « memory_fallback » quand le stockage Redis a échoué (limitation non partagée entre instances)', async () => {
    const store = new ResilientRateLimitStore(brokenStore(), memoryStore());
    await store.hit('k', 1_000, 5, 0);

    const report = await new HealthController(clientReplying(() => Promise.reject(new Error('coupé'))), store).ready();

    expect(report).toEqual({ status: 'ok', checks: { redis: 'down', rateLimit: 'memory_fallback' } });
  });
});
