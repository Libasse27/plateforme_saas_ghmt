import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Clock } from '../../../common/time/clock';
import { ENV, type Env } from '../../../infrastructure/config/env';
import { PlatformDb } from '../../../infrastructure/prisma/platform-db.service';
import { TenantDb } from '../../../infrastructure/prisma/tenant-db.service';
import { SWEEPER_HORIZON_MS, SWEEPER_MIN_LEAD_MS } from '../notifications.constants';
import { AppointmentPlanningService } from '../services/appointment-planning.service';

export interface SweepReport {
  readonly examined: number;
  readonly created: number;
  readonly errors: number;
}

/**
 * Balayeur de rattrapage (docs/10 §5.8), toutes les 15 minutes : pour les rendez-vous `scheduled|confirmed` des 26 prochaines
 * heures, recrée les rappels attendus manquants et encore à plus de 5 minutes de leur envoi, en prenant `created_at` du
 * rendez-vous comme instant de prise. Idempotent par la clé de déduplication.
 */
@Injectable()
export class ReminderSweeperJob {
  private readonly logger = new Logger(ReminderSweeperJob.name);
  private running = false;

  constructor(
    private readonly platformDb: PlatformDb,
    private readonly db: TenantDb,
    private readonly planning: AppointmentPlanningService,
    private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Cron('*/15 * * * *')
  async scheduledRun(): Promise<void> {
    if (!this.env.NOTIFICATIONS_WORKER_ENABLED || this.running) return;
    this.running = true;
    try {
      const report = await this.runOnce(this.clock.now());
      this.logger.log({ ...report }, 'Balayage des rappels');
    } catch (error: unknown) {
      this.logger.error({ errorCode: error instanceof Error ? error.name : 'unknown' }, 'Échec du balayage des rappels');
    } finally {
      this.running = false;
    }
  }

  async runOnce(now: Date, options: { readonly tenantIds?: readonly string[] } = {}): Promise<SweepReport> {
    const tenantIds = options.tenantIds ?? (await this.activeTenants());
    let examined = 0;
    let created = 0;
    let errors = 0;
    for (const tenantId of tenantIds) {
      try {
        const report = await this.sweepTenant(tenantId, now);
        examined += report.examined;
        created += report.created;
      } catch (error: unknown) {
        errors += 1;
        this.logger.error({ tenantId, errorCode: error instanceof Error ? error.name : 'unknown' }, 'Balayage impossible pour un établissement');
      }
    }
    return { examined, created, errors };
  }

  private sweepTenant(tenantId: string, now: Date): Promise<{ examined: number; created: number }> {
    return this.db.runAs(tenantId, async (tx) => {
      const appointments = await tx.appointment.findMany({
        where: { tenantId, deletedAt: null, status: { in: ['scheduled', 'confirmed'] }, startsAt: { gt: now, lte: new Date(now.getTime() + SWEEPER_HORIZON_MS) } },
        select: { id: true },
        orderBy: { startsAt: 'asc' },
      });
      let created = 0;
      for (const { id } of appointments) created += await this.planning.planMissingReminders(tx, tenantId, id, now, SWEEPER_MIN_LEAD_MS);
      return { examined: appointments.length, created };
    });
  }

  private async activeTenants(): Promise<string[]> {
    const tenants = await this.platformDb.run((tx) =>
      tx.tenant.findMany({ where: { deletedAt: null, status: { in: ['active', 'suspended'] } }, select: { id: true }, orderBy: { id: 'asc' } }),
    );
    return tenants.map((tenant) => tenant.id);
  }
}
