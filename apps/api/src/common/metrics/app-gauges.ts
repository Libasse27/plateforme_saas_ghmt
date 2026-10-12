import { Gauge } from 'prom-client';
import type { TenantDb } from '../../infrastructure/prisma/tenant-db.service';
import type { RateLimitStore } from '../rate-limit/rate-limit-store';
import { ResilientRateLimitStore } from '../rate-limit/resilient-rate-limit-store';
import type { ApiMetrics } from './metrics.registry';

/** Plafond de la fonction de découverte (identique à celui du dispatcher). */
const DUE_TENANTS_SCAN_LIMIT = 500;
/** Une découverte au plus par intervalle, quel que soit le nombre de collectes (plusieurs Prometheus, rechargements). */
const DUE_TENANTS_CACHE_MS = 15_000;

/**
 * Limiteur de débit en repli mémoire (docs/11, `checks.rateLimit` de /health/ready) : 1 si Redis est tombé.
 * Alerte D12 « limiteur en repli mémoire ».
 */
export function registerRateLimitGauge(metrics: ApiMetrics, store: RateLimitStore): void {
  new Gauge({
    name: 'ghmt_rate_limit_degraded',
    help: '1 si la limitation de débit fonctionne en repli mémoire (Redis indisponible), 0 sinon.',
    registers: [metrics.registry],
    collect() {
      this.set(store instanceof ResilientRateLimitStore && store.isDegraded() ? 1 : 0);
    },
  });
}

/**
 * Nombre d'établissements ayant un événement d'outbox ou une notification DUE (fonction SECURITY DEFINER du
 * dispatcher : identifiants seulement, agrégés ici en un nombre, sans tenant en label). Une valeur qui ne retombe
 * jamais à 0 signale une file en retard (alerte D12) ; -1 si la base ne répond pas.
 */
export function registerNotificationsDueGauge(metrics: ApiMetrics, db: TenantDb, now: () => number = Date.now): void {
  let cached: { value: number; at: number } | null = null;
  new Gauge({
    name: 'ghmt_notifications_due_tenants',
    help: 'Établissements ayant des notifications ou événements d’outbox dus (file de notifications).',
    registers: [metrics.registry],
    async collect() {
      if (!cached || now() - cached.at >= DUE_TENANTS_CACHE_MS) {
        cached = { value: await countDueTenants(db), at: now() };
      }
      this.set(cached.value);
    },
  });
}

async function countDueTenants(db: TenantDb): Promise<number> {
  try {
    const rows = await db.runWithoutTenant(
      (tx) => tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM platform.notification_due_tenants(${DUE_TENANTS_SCAN_LIMIT}::int)`,
    );
    return Number(rows[0]?.n ?? 0);
  } catch {
    return -1;
  }
}
