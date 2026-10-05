import { Inject, Injectable, Logger } from '@nestjs/common';
import type { NotificationOutboxEvent } from '../../../generated/prisma/client';
import { ENV, type Env } from '../../../infrastructure/config/env';
import { TenantDb, type TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { OUTBOX_BACKOFF_BASE_MS, OUTBOX_MAX_ATTEMPTS } from '../notifications.constants';
import { OutboxRepository } from '../repositories/outbox.repository';
import { AppointmentPlanningService } from './appointment-planning.service';

export interface RelayReport {
  readonly processed: number;
  readonly failed: number;
}

const SAVEPOINT = 'outbox_event';

/**
 * Relais de l'outbox (docs/10 §5.8) : réserve un lot d'événements `pending` (`FOR UPDATE SKIP LOCKED`), planifie les
 * notifications et marque `processed`, dans UNE transaction. Chaque événement tourne sous un point de sauvegarde : une erreur
 * l'annule seul, puis `attempts + 1` et un nouveau délai (1 min × 2^n), `failed` après 10 essais.
 */
@Injectable()
export class OutboxRelayService {
  private readonly logger = new Logger(OutboxRelayService.name);

  constructor(
    private readonly db: TenantDb,
    private readonly outbox: OutboxRepository,
    private readonly planning: AppointmentPlanningService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  relayTenant(tenantId: string, now: Date): Promise<RelayReport> {
    return this.db.runAs(tenantId, async (tx) => {
      const events = await this.outbox.reserveDue(tx, tenantId, now, this.env.NOTIFICATIONS_BATCH_SIZE);
      let failed = 0;
      for (const event of events) {
        if (!(await this.processEvent(tx, tenantId, event, now))) failed += 1;
      }
      return { processed: events.length - failed, failed };
    });
  }

  private async processEvent(tx: TenantTx, tenantId: string, event: NotificationOutboxEvent, now: Date): Promise<boolean> {
    await tx.$executeRawUnsafe(`SAVEPOINT ${SAVEPOINT}`);
    try {
      await this.planning.handleEvent(tx, tenantId, event, now);
      await this.outbox.markProcessed(tx, tenantId, event.id, now);
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${SAVEPOINT}`);
      return true;
    } catch (error: unknown) {
      await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
      await this.recordFailure(tx, tenantId, event, error, now);
      return false;
    }
  }

  private async recordFailure(tx: TenantTx, tenantId: string, event: NotificationOutboxEvent, error: unknown, now: Date): Promise<void> {
    const errorCode = error instanceof Error ? error.name.slice(0, 50) : 'unknown';
    const final = event.attempts + 1 >= OUTBOX_MAX_ATTEMPTS;
    const availableAt = new Date(now.getTime() + OUTBOX_BACKOFF_BASE_MS * 2 ** event.attempts);
    await this.outbox.markFailed(tx, tenantId, event, { final, availableAt, errorCode });
    this.logger.error({ eventId: event.id, eventType: event.eventType, attempts: event.attempts + 1, final, errorCode }, 'Échec du relais d’un événement d’outbox');
  }
}
