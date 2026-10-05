import { Injectable } from '@nestjs/common';
import type { AuditOutcomeValue } from '@ghmt/shared';
import type { AuditLog, Prisma } from '../../../generated/prisma/client';
import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import type { AuditChainRow } from '../domain/chain-verification';

export interface AuditCriteria {
  readonly from: Date;
  readonly to: Date;
  readonly actorUserId?: string | undefined;
  readonly action?: string | undefined;
  readonly resourceType?: string | undefined;
  readonly resourceId?: string | undefined;
  readonly outcome?: AuditOutcomeValue | undefined;
  /** Curseur : seuls les maillons strictement plus anciens sont lus. */
  readonly beforeSeq?: bigint | undefined;
}

const PREFIX_SUFFIX = '.*';

/** `patient.*` désigne le préfixe `patient.` ; toute autre valeur est une égalité stricte (index `ix_audit_logs_action`). */
function actionFilter(action: string): Prisma.AuditLogWhereInput {
  return action.endsWith(PREFIX_SUFFIX) ? { action: { startsWith: action.slice(0, -1) } } : { action };
}

export function buildAuditWhere(tenantId: string, criteria: AuditCriteria): Prisma.AuditLogWhereInput {
  return {
    tenantId,
    occurredAt: { gte: criteria.from, lte: criteria.to },
    ...(criteria.actorUserId ? { actorUserId: criteria.actorUserId } : {}),
    ...(criteria.action ? actionFilter(criteria.action) : {}),
    ...(criteria.resourceType ? { resourceType: criteria.resourceType } : {}),
    ...(criteria.resourceId ? { resourceId: criteria.resourceId } : {}),
    ...(criteria.outcome ? { outcome: criteria.outcome } : {}),
    ...(criteria.beforeSeq !== undefined ? { chainSeq: { lt: criteria.beforeSeq } } : {}),
  };
}

@Injectable()
export class AuditLogsRepository {
  find(tx: TenantTx, tenantId: string, criteria: AuditCriteria, take: number): Promise<AuditLog[]> {
    return tx.auditLog.findMany({ where: buildAuditWhere(tenantId, criteria), orderBy: { chainSeq: 'desc' }, take });
  }

  count(tx: TenantTx, tenantId: string, criteria: AuditCriteria): Promise<number> {
    return tx.auditLog.count({ where: buildAuditWhere(tenantId, criteria) });
  }

  /** Noms du personnel acteur : jointure sur `tenant.users` uniquement, jamais sur un patient. */
  async actorNames(tx: TenantTx, tenantId: string, rows: readonly AuditLog[]): Promise<ReadonlyMap<string, string>> {
    const ids = [...new Set(rows.flatMap((row) => (row.actorUserId ? [row.actorUserId] : [])))];
    if (ids.length === 0) return new Map();
    const users = await tx.user.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, fullName: true } });
    return new Map(users.map((user) => [user.id, user.fullName]));
  }

  /** Lot de maillons par numéro décroissant (relecture de la chaîne). */
  chainBatch(tx: TenantTx, tenantId: string, beforeSeq: bigint | undefined, take: number): Promise<AuditChainRow[]> {
    return tx.auditLog.findMany({
      where: { tenantId, ...(beforeSeq !== undefined ? { chainSeq: { lt: beforeSeq } } : {}) },
      orderBy: { chainSeq: 'desc' },
      take,
      select: {
        tenantId: true,
        chainSeq: true,
        occurredAt: true,
        actorType: true,
        actorUserId: true,
        sessionId: true,
        ip: true,
        action: true,
        resourceType: true,
        resourceId: true,
        patientId: true,
        outcome: true,
        changes: true,
        requestId: true,
        prevHash: true,
        hash: true,
      },
    });
  }
}
