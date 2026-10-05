import { Injectable, Logger } from '@nestjs/common';
import { TenantDb } from '../../../infrastructure/prisma/tenant-db.service';
import { DUE_TENANTS_LIMIT } from '../notifications.constants';
import { NotificationDeliveryService } from './notification-delivery.service';
import { OutboxRelayService } from './outbox-relay.service';

export interface DispatchOptions {
  /** Restreint la passe à ces établissements (tests) ; sinon découverte par `platform.notification_due_tenants`. */
  readonly tenantIds?: readonly string[];
}

export interface DispatchReport {
  readonly tenants: number;
  readonly relayed: number;
  readonly delivered: number;
  readonly errors: number;
}

/**
 * Tick du dispatcher (docs/10 §5.8) : pour chaque établissement dû, relais de l'outbox puis envoi des notifications dues.
 * `runOnce(now)` est déterministe : l'horloge est un paramètre. Un établissement en erreur n'interrompt pas les autres.
 */
@Injectable()
export class NotificationDispatcher {
  private readonly logger = new Logger(NotificationDispatcher.name);

  constructor(
    private readonly db: TenantDb,
    private readonly relay: OutboxRelayService,
    private readonly delivery: NotificationDeliveryService,
  ) {}

  async runOnce(now: Date, options: DispatchOptions = {}): Promise<DispatchReport> {
    const tenantIds = options.tenantIds ?? (await this.discoverDueTenants());
    let relayed = 0;
    let delivered = 0;
    let errors = 0;
    for (const tenantId of tenantIds) {
      try {
        relayed += (await this.relay.relayTenant(tenantId, now)).processed;
        delivered += (await this.delivery.deliverTenant(tenantId, now)).processed;
      } catch (error: unknown) {
        errors += 1;
        this.logger.error({ tenantId, errorCode: error instanceof Error ? error.name : 'unknown' }, 'Échec du traitement des notifications d’un établissement');
      }
    }
    return { tenants: tenantIds.length, relayed, delivered, errors };
  }

  /** Établissements ayant un événement ou une notification due (fonction SECURITY DEFINER : identifiants seulement). */
  private async discoverDueTenants(): Promise<string[]> {
    const rows = await this.db.runWithoutTenant((tx) => tx.$queryRaw<{ id: string }[]>`SELECT platform.notification_due_tenants(${DUE_TENANTS_LIMIT}::int)::text AS id`);
    return rows.map((row) => row.id);
  }
}
