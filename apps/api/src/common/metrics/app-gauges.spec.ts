import { describe, expect, it, vi } from 'vitest';
import type { TenantDb } from '../../infrastructure/prisma/tenant-db.service';
import { MemoryRateLimitStore } from '../rate-limit/memory-rate-limit-store';
import { ResilientRateLimitStore } from '../rate-limit/resilient-rate-limit-store';
import { registerNotificationsDueGauge, registerRateLimitGauge } from './app-gauges';
import { createApiMetrics } from './metrics.registry';

async function gaugeValue(metrics: ReturnType<typeof createApiMetrics>, name: string): Promise<number> {
  const metric = await metrics.registry.getSingleMetric(name)!.get();
  return metric.values[0]!.value;
}

describe('ghmt_rate_limit_degraded', () => {
  it('vaut 1 en repli mémoire, 0 sinon (y compris en stockage mémoire configuré)', async () => {
    const degraded = Object.create(ResilientRateLimitStore.prototype) as ResilientRateLimitStore;
    vi.spyOn(degraded, 'isDegraded').mockReturnValue(true);
    const withFallback = createApiMetrics();
    registerRateLimitGauge(withFallback, degraded);
    expect(await gaugeValue(withFallback, 'ghmt_rate_limit_degraded')).toBe(1);

    const memory = createApiMetrics();
    registerRateLimitGauge(memory, new MemoryRateLimitStore());
    expect(await gaugeValue(memory, 'ghmt_rate_limit_degraded')).toBe(0);
  });
});

describe('ghmt_notifications_due_tenants', () => {
  function dbReturning(run: () => Promise<{ n: bigint }[]>): { db: TenantDb; calls: () => number } {
    let calls = 0;
    const db = {
      runWithoutTenant: () => {
        calls += 1;
        return run();
      },
    } as unknown as TenantDb;
    return { db, calls: () => calls };
  }

  it('compte les établissements dus et ne relance la découverte qu’après 15 s', async () => {
    let now = 1_000_000;
    const { db, calls } = dbReturning(() => Promise.resolve([{ n: 3n }]));
    const metrics = createApiMetrics();
    registerNotificationsDueGauge(metrics, db, () => now);
    expect(await gaugeValue(metrics, 'ghmt_notifications_due_tenants')).toBe(3);
    now += 5_000;
    await gaugeValue(metrics, 'ghmt_notifications_due_tenants');
    expect(calls()).toBe(1);
    now += 15_000;
    await gaugeValue(metrics, 'ghmt_notifications_due_tenants');
    expect(calls()).toBe(2);
  });

  it('vaut -1 si la base ne répond pas (sans lever)', async () => {
    const { db } = dbReturning(() => Promise.reject(new Error('base indisponible')));
    const metrics = createApiMetrics();
    registerNotificationsDueGauge(metrics, db);
    expect(await gaugeValue(metrics, 'ghmt_notifications_due_tenants')).toBe(-1);
  });
});
