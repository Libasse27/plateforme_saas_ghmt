import { createHash } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { ExportAuditLogsInput } from '@ghmt/shared';
import { AuditService } from '../../../common/audit/audit.service';
import { RequestContext } from '../../../common/context/request-context';
import { DomainError } from '../../../common/errors/domain-error';
import { Clock } from '../../../common/time/clock';
import { TenantDb } from '../../../infrastructure/prisma/tenant-db.service';
import { AUDIT_EXPORT_LIMIT } from '../admin.constants';
import { auditCsvFilename, buildAuditCsv } from '../domain/audit-csv';
import { resolveAuditRange } from '../domain/audit-range';
import { toAuditLogView } from '../mappers/audit-log.mapper';
import { AuditLogsRepository } from '../repositories/audit-logs.repository';
import { auditedFilters, toAuditCriteria } from './audit-query';

export interface AuditExportFile {
  readonly filename: string;
  readonly content: Buffer;
}

/** Export CSV du journal d'audit (US-042) : plafonné, assaini, protégé contre l'injection de formules, audité avant l'envoi. */
@Injectable()
export class AuditExportService {
  constructor(
    private readonly db: TenantDb,
    private readonly repo: AuditLogsRepository,
    private readonly audit: AuditService,
    private readonly context: RequestContext,
    private readonly clock: Clock,
    @Inject(AUDIT_EXPORT_LIMIT) private readonly maxRows: number,
  ) {}

  export(filters: ExportAuditLogsInput): Promise<AuditExportFile> {
    const { tenantId } = this.context.requirePrincipal();
    const range = resolveAuditRange(filters, this.clock.now());
    const criteria = toAuditCriteria(filters, range);
    return this.db.run(async (tx) => {
      const count = await this.repo.count(tx, tenantId, criteria);
      if (count > this.maxRows) throw this.tooLarge(count);
      const rows = await this.repo.find(tx, tenantId, criteria, this.maxRows);
      const names = await this.repo.actorNames(tx, tenantId, rows);
      const content = Buffer.from(buildAuditCsv(rows.map((row) => toAuditLogView(row, names))), 'utf8');
      // L'audit est écrit dans la transaction de lecture, donc avant que le fichier ne parte vers le client.
      await this.audit.record(tx, tenantId, {
        action: 'audit.logs_exported',
        resourceType: 'audit_log',
        changes: { filters: auditedFilters(filters, range), rowCount: rows.length, sha256: createHash('sha256').update(content).digest('hex') },
      });
      return { filename: auditCsvFilename(range.from, range.to), content };
    });
  }

  private tooLarge(count: number): DomainError {
    return new DomainError(
      'export_too_large',
      HttpStatus.UNPROCESSABLE_ENTITY,
      'Unprocessable Entity',
      'L’export dépasse le nombre de lignes autorisé : affinez les filtres.',
      { details: { count, max: this.maxRows } },
    );
  }
}
