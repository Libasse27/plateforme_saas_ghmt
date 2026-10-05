import { Injectable } from '@nestjs/common';
import type { InAppMessage } from '../../../generated/prisma/client';
import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { INAPP_UNREAD_CAP } from '../notifications.constants';

@Injectable()
export class InboxRepository {
  list(
    tx: TenantTx,
    tenantId: string,
    userId: string,
    options: { now: Date; unreadOnly: boolean; beforeId?: string; take: number },
  ): Promise<InAppMessage[]> {
    return tx.inAppMessage.findMany({
      where: {
        tenantId,
        userId,
        expiresAt: { gt: options.now },
        ...(options.unreadOnly ? { readAt: null } : {}),
        ...(options.beforeId ? { id: { lt: options.beforeId } } : {}),
      },
      orderBy: { id: 'desc' },
      take: options.take,
    });
  }

  /** Compteur plafonné : on ne lit jamais plus de `INAPP_UNREAD_CAP + 1` lignes. */
  async countUnread(tx: TenantTx, tenantId: string, userId: string, now: Date): Promise<{ count: number; capped: boolean }> {
    const rows = await tx.inAppMessage.findMany({
      where: { tenantId, userId, readAt: null, expiresAt: { gt: now } },
      select: { id: true },
      take: INAPP_UNREAD_CAP + 1,
    });
    return { count: Math.min(rows.length, INAPP_UNREAD_CAP), capped: rows.length > INAPP_UNREAD_CAP };
  }

  findOwn(tx: TenantTx, tenantId: string, userId: string, id: string, now: Date): Promise<InAppMessage | null> {
    return tx.inAppMessage.findFirst({ where: { tenantId, userId, id, expiresAt: { gt: now } } });
  }

  async markRead(tx: TenantTx, tenantId: string, userId: string, id: string, now: Date): Promise<void> {
    await tx.inAppMessage.updateMany({ where: { tenantId, userId, id, readAt: null }, data: { readAt: now } });
  }

  async markAllRead(tx: TenantTx, tenantId: string, userId: string, now: Date): Promise<number> {
    const { count } = await tx.inAppMessage.updateMany({ where: { tenantId, userId, readAt: null, expiresAt: { gt: now } }, data: { readAt: now } });
    return count;
  }

  async purgeExpired(tx: TenantTx, tenantId: string, now: Date): Promise<number> {
    const { count } = await tx.inAppMessage.deleteMany({ where: { tenantId, expiresAt: { lte: now } } });
    return count;
  }
}
