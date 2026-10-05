import { Injectable } from '@nestjs/common';
import type { AuditChainVerificationView, VerifyAuditChainQuery } from '@ghmt/shared';
import { AuditService } from '../../../common/audit/audit.service';
import { RequestContext } from '../../../common/context/request-context';
import { Clock } from '../../../common/time/clock';
import { TenantDb } from '../../../infrastructure/prisma/tenant-db.service';
import { AUDIT_VERIFY_BATCH_SIZE } from '../admin.constants';
import { findFirstBrokenSeq, type AuditChainRow } from '../domain/chain-verification';
import { AuditLogsRepository } from '../repositories/audit-logs.repository';

interface ScanResult {
  readonly checkedCount: number;
  readonly fromSeq: bigint | null;
  readonly toSeq: bigint | null;
  readonly firstBrokenSeq: bigint | null;
}

const EMPTY_SCAN: ScanResult = { checkedCount: 0, fromSeq: null, toSeq: null, firstBrokenSeq: null };

function smallest(a: bigint | null, b: bigint | null): bigint | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

/** Vérification d'intégrité de la chaîne d'audit du tenant (US-041, partie API) : relecture par lots, recalcul des empreintes. */
@Injectable()
export class AuditChainVerificationService {
  constructor(
    private readonly db: TenantDb,
    private readonly repo: AuditLogsRepository,
    private readonly audit: AuditService,
    private readonly context: RequestContext,
    private readonly clock: Clock,
  ) {}

  async verify(query: VerifyAuditChainQuery): Promise<AuditChainVerificationView> {
    const { tenantId } = this.context.requirePrincipal();
    const scan = await this.scan(tenantId, query.limit);
    const view = this.toView(scan);
    await this.db.run((tx) =>
      this.audit.record(tx, tenantId, {
        action: 'audit.chain_verified',
        resourceType: 'audit_log',
        changes: { status: view.status, checkedCount: view.checkedCount, fromSeq: view.fromSeq, toSeq: view.toSeq, firstBrokenSeq: view.firstBrokenSeq },
      }),
    );
    return view;
  }

  /**
   * Lots lus du plus récent au plus ancien, chacun dans une courte transaction (la chaîne est en ajout seul).
   * Le premier maillon du lot plus récent sert de maillon de liaison pour contrôler la jonction des deux lots.
   */
  private async scan(tenantId: string, limit: number): Promise<ScanResult> {
    let result = EMPTY_SCAN;
    let beforeSeq: bigint | undefined;
    let carry: AuditChainRow | undefined;
    while (result.checkedCount < limit) {
      const take = Math.min(AUDIT_VERIFY_BATCH_SIZE, limit - result.checkedCount);
      const batch = await this.db.run((tx) => this.repo.chainBatch(tx, tenantId, beforeSeq, take));
      if (batch.length === 0) break;
      const ascending = [...batch].reverse();
      result = this.merge(result, ascending, carry);
      carry = ascending[0];
      beforeSeq = ascending[0]!.chainSeq;
      if (batch.length < take) break;
    }
    return result;
  }

  private merge(previous: ScanResult, ascending: readonly AuditChainRow[], carry: AuditChainRow | undefined): ScanResult {
    const window = carry ? [...ascending, carry] : ascending;
    return {
      checkedCount: previous.checkedCount + ascending.length,
      fromSeq: ascending[0]!.chainSeq,
      toSeq: previous.toSeq ?? ascending[ascending.length - 1]!.chainSeq,
      firstBrokenSeq: smallest(previous.firstBrokenSeq, findFirstBrokenSeq(window)),
    };
  }

  private toView(scan: ScanResult): AuditChainVerificationView {
    const status = scan.checkedCount === 0 ? 'empty' : scan.firstBrokenSeq === null ? 'intact' : 'broken';
    return {
      status,
      checkedCount: scan.checkedCount,
      fromSeq: scan.fromSeq?.toString() ?? null,
      toSeq: scan.toSeq?.toString() ?? null,
      firstBrokenSeq: scan.firstBrokenSeq?.toString() ?? null,
      checkedAt: this.clock.now().toISOString(),
    };
  }
}
