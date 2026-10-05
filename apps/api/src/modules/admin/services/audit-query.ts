import type { AuditLogFilters } from '@ghmt/shared';
import type { AuditRange } from '../domain/audit-range';
import type { AuditCriteria } from '../repositories/audit-logs.repository';

/** Critères de lecture issus des filtres validés et de la période effective. */
export function toAuditCriteria(filters: AuditLogFilters, range: AuditRange, beforeSeq?: bigint): AuditCriteria {
  return {
    from: range.from,
    to: range.to,
    actorUserId: filters.actorUserId,
    action: filters.action,
    resourceType: filters.resourceType,
    resourceId: filters.resourceId,
    outcome: filters.outcome,
    beforeSeq,
  };
}

/** Filtres effectifs consignés dans l'audit (valeurs fournies et période résolue ; jamais de donnée libre). */
export function auditedFilters(filters: AuditLogFilters, range: AuditRange): Record<string, string> {
  const provided = Object.entries({
    actorUserId: filters.actorUserId,
    action: filters.action,
    resourceType: filters.resourceType,
    resourceId: filters.resourceId,
    outcome: filters.outcome,
  }).filter((entry): entry is [string, string] => entry[1] !== undefined);
  return { ...Object.fromEntries(provided), from: range.from.toISOString(), to: range.to.toISOString() };
}
