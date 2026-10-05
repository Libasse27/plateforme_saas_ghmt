import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Clock } from '../../../common/time/clock';
import { ENV, type Env } from '../../../infrastructure/config/env';
import { PlatformDb } from '../../../infrastructure/prisma/platform-db.service';
import { TenantDb } from '../../../infrastructure/prisma/tenant-db.service';
import { OUTBOX_RETENTION_MS, STOP_ROUTING_WINDOW_MS } from '../notifications.constants';
import { InboxRepository } from '../repositories/inbox.repository';
import { OutboxRepository } from '../repositories/outbox.repository';
import { SmsRecipientRegistry } from '../services/sms-recipient-registry';

export interface RetentionReport {
  readonly inappPurged: number;
  readonly outboxPurged: number;
  readonly routingPurged: number;
  readonly errors: number;
}

/**
 * Rétention (docs/10 §5.8), chaque jour à 03:30 UTC : messages in-app expirés, événements d'outbox `processed` de plus de
 * 30 jours, routage STOP (`platform.sms_recipient_tenants`) de plus de 180 jours. Le journal des envois est conservé.
 */
@Injectable()
export class NotificationRetentionJob {
  private readonly logger = new Logger(NotificationRetentionJob.name);

  constructor(
    private readonly platformDb: PlatformDb,
    private readonly db: TenantDb,
    private readonly inbox: InboxRepository,
    private readonly outbox: OutboxRepository,
    private readonly registry: SmsRecipientRegistry,
    private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Cron('30 3 * * *', { timeZone: 'UTC' })
  async scheduledRun(): Promise<void> {
    if (!this.env.NOTIFICATIONS_WORKER_ENABLED) return;
    try {
      this.logger.log({ ...(await this.runOnce(this.clock.now())) }, 'Rétention des notifications');
    } catch (error: unknown) {
      this.logger.error({ errorCode: error instanceof Error ? error.name : 'unknown' }, 'Échec de la rétention des notifications');
    }
  }

  async runOnce(now: Date, options: { readonly tenantIds?: readonly string[] } = {}): Promise<RetentionReport> {
    const tenantIds = options.tenantIds ?? (await this.activeTenants());
    let inappPurged = 0;
    let outboxPurged = 0;
    let errors = 0;
    for (const tenantId of tenantIds) {
      try {
        const purged = await this.purgeTenant(tenantId, now);
        inappPurged += purged.inapp;
        outboxPurged += purged.outbox;
      } catch (error: unknown) {
        errors += 1;
        this.logger.error({ tenantId, errorCode: error instanceof Error ? error.name : 'unknown' }, 'Rétention impossible pour un établissement');
      }
    }
    const routingPurged = await this.registry.purgeOlderThan(new Date(now.getTime() - STOP_ROUTING_WINDOW_MS));
    return { inappPurged, outboxPurged, routingPurged, errors };
  }

  private purgeTenant(tenantId: string, now: Date): Promise<{ inapp: number; outbox: number }> {
    return this.db.runAs(tenantId, async (tx) => ({
      inapp: await this.inbox.purgeExpired(tx, tenantId, now),
      outbox: await this.outbox.purgeProcessed(tx, tenantId, new Date(now.getTime() - OUTBOX_RETENTION_MS)),
    }));
  }

  private async activeTenants(): Promise<string[]> {
    const tenants = await this.platformDb.run((tx) => tx.tenant.findMany({ where: { deletedAt: null }, select: { id: true }, orderBy: { id: 'asc' } }));
    return tenants.map((tenant) => tenant.id);
  }
}
