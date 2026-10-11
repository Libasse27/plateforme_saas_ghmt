import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '../../../generated/prisma/client';
import { Clock } from '../../../common/time/clock';
import { ENV, type Env } from '../../../infrastructure/config/env';
import { PlatformDb } from '../../../infrastructure/prisma/platform-db.service';
import { TenantDb, type TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { PURGE_BATCH_SIZE, PURGE_RULES, type PurgeRule } from './purge-rules';

export interface PurgeEntry {
  readonly tenantId: string;
  readonly table: string;
  readonly deleted: number;
}

const STARTUP_DELAY_MS = 60_000;

/**
 * Purge planifiée des jetons et sessions périmés (docs/11 D16), chaque jour à 03:45 UTC et 60 s après le démarrage,
 * par établissement (`runAs`). Seuls des comptes sont journalisés : aucune audit par ligne, aucune valeur de jeton.
 */
@Injectable()
export class AuthTokenPurgeJob implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AuthTokenPurgeJob.name);
  private startupTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly platformDb: PlatformDb,
    private readonly db: TenantDb,
    private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.env.SECURITY_JOBS_ENABLED) return;
    this.startupTimer = setTimeout(() => void this.scheduledRun(), STARTUP_DELAY_MS);
    this.startupTimer.unref();
  }

  onApplicationShutdown(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
  }

  @Cron('45 3 * * *', { timeZone: 'UTC' })
  async scheduledRun(): Promise<void> {
    if (!this.env.SECURITY_JOBS_ENABLED) return;
    try {
      await this.runOnce(this.clock.now());
    } catch (error: unknown) {
      this.logger.error({ errorCode: error instanceof Error ? error.name : 'unknown' }, 'Échec de la purge des jetons');
    }
  }

  async runOnce(now: Date, options: { readonly tenantIds?: readonly string[] } = {}): Promise<PurgeEntry[]> {
    const tenantIds = options.tenantIds ?? (await this.purgeableTenantIds());
    const report: PurgeEntry[] = [];
    for (const tenantId of tenantIds) {
      for (const rule of PURGE_RULES) {
        try {
          const deleted = await this.db.runAs(tenantId, (tx) => this.purge(tx, tenantId, rule, now));
          if (deleted > 0) {
            report.push({ tenantId, table: rule.table, deleted });
            this.logger.log({ tenantId, table: rule.table, deleted }, 'Purge des jetons');
          }
        } catch (error: unknown) {
          this.logger.error({ tenantId, table: rule.table, errorCode: error instanceof Error ? error.name : 'unknown' }, 'Purge impossible');
        }
      }
    }
    return report;
  }

  private purge(tx: TenantTx, tenantId: string, rule: PurgeRule, now: Date): Promise<number> {
    return tx.$executeRaw(Prisma.sql`
      DELETE FROM ${rule.identifier}
      WHERE (tenant_id, id) IN (
        SELECT tenant_id, id FROM ${rule.identifier}
        WHERE tenant_id = ${tenantId}::uuid AND ${rule.condition(now)}
        LIMIT ${PURGE_BATCH_SIZE})`);
  }

  /**
   * Établissements à purger : tous les établissements vivants, et aussi les résiliés (`terminated`, y compris les inscriptions
   * expirées marquées `deleted_at`) dont les jetons et sessions ne doivent pas survivre indéfiniment (docs/11 §14.2 M7).
   */
  async purgeableTenantIds(): Promise<string[]> {
    const rows = await this.platformDb.run((tx) =>
      tx.tenant.findMany({ where: { OR: [{ deletedAt: null }, { status: 'terminated' }] }, select: { id: true }, orderBy: { id: 'asc' } }),
    );
    return rows.map((row) => row.id);
  }
}
