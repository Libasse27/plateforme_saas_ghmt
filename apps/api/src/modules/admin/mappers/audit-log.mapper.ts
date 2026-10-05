import type { AuditLogView, AuditOutcomeValue } from '@ghmt/shared';
import type { AuditLog } from '../../../generated/prisma/client';
import { sanitizeAuditChanges } from '../domain/audit-sanitizer';

/** Vue d'un événement : `changes` assaini, aucune empreinte, nom du personnel seulement. */
export function toAuditLogView(row: AuditLog, actorNames: ReadonlyMap<string, string>): AuditLogView {
  return {
    id: row.id,
    seq: row.chainSeq.toString(),
    occurredAt: row.occurredAt.toISOString(),
    actor: {
      type: row.actorType,
      userId: row.actorUserId,
      fullName: row.actorUserId ? (actorNames.get(row.actorUserId) ?? null) : null,
    },
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    patientId: row.patientId,
    outcome: row.outcome as AuditOutcomeValue,
    ip: row.ip,
    requestId: row.requestId,
    changes: sanitizeAuditChanges(row.changes),
  };
}
