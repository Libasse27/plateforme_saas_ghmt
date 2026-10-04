import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Page, decodeUuidCursor } from '../../../common/pagination/page';
import { PlatformDb } from '../../../infrastructure/prisma/platform-db.service';

export const listAuditLogsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(200).optional(),
  tenantId: z.uuid().optional(),
  action: z.string().min(1).max(100).optional(),
});
export type ListAuditLogsQuery = z.infer<typeof listAuditLogsQuerySchema>;

export interface PlatformAuditLogView {
  readonly id: string;
  readonly occurredAt: string;
  readonly actorType: string;
  readonly actorUserId: string | null;
  readonly actorRole: string | null;
  readonly action: string;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly tenantId: string | null;
  readonly outcome: string;
  readonly changes: unknown;
}

/** Consultation du journal d'audit plateforme (lecture seule, permission `audit:read`). */
@Injectable()
export class PlatformAuditLogsService {
  constructor(private readonly platformDb: PlatformDb) {}

  list(query: ListAuditLogsQuery): Promise<Page<PlatformAuditLogView>> {
    const after = decodeUuidCursor(query.cursor);
    return this.platformDb.run(async (tx) => {
      const rows = await tx.platformAuditLog.findMany({
        where: {
          ...(query.tenantId ? { tenantId: query.tenantId } : {}),
          ...(query.action ? { action: query.action } : {}),
          ...(after ? { id: { lt: after } } : {}),
        },
        orderBy: { id: 'desc' },
        take: query.limit + 1,
      });
      return Page.fromRows(
        rows,
        query.limit,
        (r) => ({
          id: r.id,
          occurredAt: r.occurredAt.toISOString(),
          actorType: r.actorType,
          actorUserId: r.actorUserId,
          actorRole: r.actorRole,
          action: r.action,
          resourceType: r.resourceType,
          resourceId: r.resourceId,
          tenantId: r.tenantId,
          outcome: r.outcome,
          changes: r.changes,
        }),
        (r) => r.id,
      );
    });
  }
}
