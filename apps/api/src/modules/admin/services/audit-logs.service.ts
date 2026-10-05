import { Injectable } from '@nestjs/common';
import type { AuditLogView, ListAuditLogsQuery } from '@ghmt/shared';
import { AuditService } from '../../../common/audit/audit.service';
import { RequestContext } from '../../../common/context/request-context';
import { Page } from '../../../common/pagination/page';
import { Clock } from '../../../common/time/clock';
import { TenantDb } from '../../../infrastructure/prisma/tenant-db.service';
import { decodeSeqCursor } from '../domain/audit-cursor';
import { resolveAuditRange } from '../domain/audit-range';
import { toAuditLogView } from '../mappers/audit-log.mapper';
import { AuditLogsRepository } from '../repositories/audit-logs.repository';
import { auditedFilters, toAuditCriteria } from './audit-query';

/** Consultation du journal d'audit du tenant courant (US-042) ; la lecture est elle-même auditée. */
@Injectable()
export class AuditLogsService {
  constructor(
    private readonly db: TenantDb,
    private readonly repo: AuditLogsRepository,
    private readonly audit: AuditService,
    private readonly context: RequestContext,
    private readonly clock: Clock,
  ) {}

  list(query: ListAuditLogsQuery): Promise<Page<AuditLogView>> {
    const { tenantId } = this.context.requirePrincipal();
    // Curseur et période sont validés avant toute requête (422).
    const beforeSeq = decodeSeqCursor(query.cursor);
    const range = resolveAuditRange(query, this.clock.now());
    return this.db.run(async (tx) => {
      const rows = await this.repo.find(tx, tenantId, toAuditCriteria(query, range, beforeSeq), query.limit + 1);
      const names = await this.repo.actorNames(tx, tenantId, rows.slice(0, query.limit));
      const page = Page.fromRows(rows, query.limit, (row) => toAuditLogView(row, names), (row) => row.chainSeq.toString());
      await this.audit.record(tx, tenantId, {
        action: 'audit.logs_read',
        resourceType: 'audit_log',
        changes: { filters: auditedFilters(query, range), resultCount: page.items.length },
      });
      return page;
    });
  }
}
