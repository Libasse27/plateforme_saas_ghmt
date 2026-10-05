import { Injectable } from '@nestjs/common';
import type { NotificationOutboxEvent } from '../../../generated/prisma/client';
import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';

@Injectable()
export class OutboxRepository {
  /** Événements dus, verrouillés pour la transaction (`FOR UPDATE SKIP LOCKED`) : deux instances ne traitent jamais le même. */
  async reserveDue(tx: TenantTx, tenantId: string, now: Date, limit: number): Promise<NotificationOutboxEvent[]> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM tenant.notification_outbox
      WHERE tenant_id = ${tenantId}::uuid AND status = 'pending' AND available_at <= ${now}::timestamptz
      ORDER BY created_at, id LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
    if (rows.length === 0) return [];
    return tx.notificationOutboxEvent.findMany({ where: { tenantId, id: { in: rows.map((r) => r.id) } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  }

  async markProcessed(tx: TenantTx, tenantId: string, id: string, now: Date): Promise<void> {
    await tx.notificationOutboxEvent.update({ where: { tenantId_id: { tenantId, id } }, data: { status: 'processed', processedAt: now, lastErrorCode: null } });
  }

  async markFailed(
    tx: TenantTx,
    tenantId: string,
    event: Pick<NotificationOutboxEvent, 'id' | 'attempts'>,
    outcome: { readonly final: boolean; readonly availableAt: Date; readonly errorCode: string },
  ): Promise<void> {
    await tx.notificationOutboxEvent.update({
      where: { tenantId_id: { tenantId, id: event.id } },
      data: {
        attempts: event.attempts + 1,
        status: outcome.final ? 'failed' : 'pending',
        availableAt: outcome.availableAt,
        lastErrorCode: outcome.errorCode,
      },
    });
  }

  /** Événements traités depuis plus de `before` (purge de rétention). */
  async purgeProcessed(tx: TenantTx, tenantId: string, before: Date): Promise<number> {
    const { count } = await tx.notificationOutboxEvent.deleteMany({ where: { tenantId, status: 'processed', processedAt: { lt: before } } });
    return count;
  }
}
