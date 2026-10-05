import { Injectable } from '@nestjs/common';
import type { ListDeliveriesQuery, NotificationDeliveryView } from '@ghmt/shared';
import { AuditService } from '../../../common/audit/audit.service';
import { RequestContext } from '../../../common/context/request-context';
import { DomainError } from '../../../common/errors/domain-error';
import { Page, decodeDateIdCursor } from '../../../common/pagination/page';
import { Clock } from '../../../common/time/clock';
import { TenantDb } from '../../../infrastructure/prisma/tenant-db.service';
import { toDeliveryView } from '../mappers/delivery.mapper';
import { DELIVERIES_DEFAULT_RANGE_MS, DELIVERIES_MAX_RANGE_MS } from '../notifications.constants';

const CURSOR_SEPARATOR = '|';

/** Journal des envois (docs/10 §5.5) : lecture seule, fenêtre de 31 jours au plus, lecture auditée (nombre de résultats). */
@Injectable()
export class DeliveriesService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly context: RequestContext,
    private readonly clock: Clock,
  ) {}

  list(query: ListDeliveriesQuery): Promise<Page<NotificationDeliveryView>> {
    const { tenantId } = this.context.requirePrincipal();
    const { from, to } = this.window(query);
    const after = decodeDateIdCursor(query.cursor);
    return this.db.run(async (tx) => {
      const rows = await tx.notification.findMany({
        where: {
          tenantId,
          createdAt: { gte: from, lte: to },
          ...(query.status ? { status: query.status } : {}),
          ...(query.channel ? { channel: query.channel } : {}),
          ...(query.typeCode ? { typeCode: query.typeCode } : {}),
          ...(after ? { OR: [{ createdAt: { lt: after.date } }, { createdAt: after.date, id: { lt: after.id } }] } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
      });
      const page = Page.fromRows(rows, query.limit, toDeliveryView, (row) => `${row.createdAt.toISOString()}${CURSOR_SEPARATOR}${row.id}`);
      await this.audit.record(tx, tenantId, { action: 'notification.deliveries_listed', resourceType: 'notification', changes: { resultCount: page.items.length } });
      return page;
    });
  }

  /** 7 jours par défaut, 31 jours au plus (422 `range_too_large`). */
  private window(query: ListDeliveriesQuery): { from: Date; to: Date } {
    const to = query.to ? new Date(query.to) : this.clock.now();
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - DELIVERIES_DEFAULT_RANGE_MS);
    if (to.getTime() - from.getTime() > DELIVERIES_MAX_RANGE_MS) {
      const issue = { path: 'to', code: 'range_too_large', message: 'La période ne peut pas dépasser 31 jours.' };
      throw new DomainError('range_too_large', 422, 'Unprocessable Entity', issue.message, { errors: [issue] });
    }
    return { from, to };
  }
}
