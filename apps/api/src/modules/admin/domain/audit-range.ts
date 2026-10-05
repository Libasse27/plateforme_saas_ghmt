import type { AuditLogFilters } from '@ghmt/shared';
import { AUDIT_DEFAULT_RANGE_DAYS, AUDIT_MAX_RANGE_DAYS } from '@ghmt/shared';
import { DomainError } from '../../../common/errors/domain-error';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AuditRange {
  readonly from: Date;
  readonly to: Date;
}

/** Période effective : 7 derniers jours par défaut, 92 jours au plus (422 `range_too_large`). `now` vient de `Clock`. */
export function resolveAuditRange(filters: Pick<AuditLogFilters, 'from' | 'to'>, now: Date): AuditRange {
  const to = filters.to ? new Date(filters.to) : now;
  const from = filters.from ? new Date(filters.from) : new Date(to.getTime() - AUDIT_DEFAULT_RANGE_DAYS * DAY_MS);
  if (from.getTime() > to.getTime()) {
    throw DomainError.validation([{ path: 'from', code: 'invalid_range', message: 'from doit précéder to.' }]);
  }
  if (to.getTime() - from.getTime() > AUDIT_MAX_RANGE_DAYS * DAY_MS) {
    throw DomainError.unprocessable('range_too_large', `La période ne peut pas dépasser ${AUDIT_MAX_RANGE_DAYS} jours.`);
  }
  return { from, to };
}
