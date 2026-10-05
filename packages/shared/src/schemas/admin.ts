/**
 * Contrats de la console d'administration de l'établissement (équipe A, docs/10-phase-notifications-admin.md §6 et §7.2).
 * Pas d'import runtime de ./index ici (dépendance circulaire à l'évaluation) : seuls des types sont importés.
 */
import { z } from 'zod';
import type { PaymentMethod } from './billing';
import type { AppointmentStatus } from './index';
import { isoDateTime, uuid } from './primitives';

export const AUDIT_OUTCOMES = ['success', 'denied', 'failure'] as const;
export type AuditOutcomeValue = (typeof AUDIT_OUTCOMES)[number];

/** Plafond de lignes d'un export CSV du journal (au-delà : 422 `export_too_large`). */
export const AUDIT_EXPORT_MAX_ROWS = 10000;
/** Fenêtre maximale d'une consultation ou d'un export (jours) ; le contrôle est fait par l'API (422 `range_too_large`). */
export const AUDIT_MAX_RANGE_DAYS = 92;
export const AUDIT_DEFAULT_RANGE_DAYS = 7;

const AUDIT_LIST_DEFAULT_LIMIT = 50;
const AUDIT_LIST_MAX_LIMIT = 100;
const AUDIT_VERIFY_MIN_LIMIT = 1000;
const AUDIT_VERIFY_MAX_LIMIT = 50000;
const CURSOR_MAX_LENGTH = 200;
const RESOURCE_TYPE_MAX_LENGTH = 50;

/** `patient.created`, ou `patient.*` pour tout le préfixe `patient.`. */
const AUDIT_ACTION_PATTERN = /^[a-z_]+(\.[a-z_]+)*(\.\*)?$/;

const auditLogFilterShape = {
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  actorUserId: uuid.optional(),
  action: z.string().max(100).regex(AUDIT_ACTION_PATTERN, 'action : minuscules, points et suffixe .* éventuel').optional(),
  resourceType: z.string().max(RESOURCE_TYPE_MAX_LENGTH).regex(/^[a-z_]{1,50}$/, 'type de ressource : minuscules et souligné').optional(),
  resourceId: uuid.optional(),
  outcome: z.enum(AUDIT_OUTCOMES).optional(),
};

type PeriodBounds = { readonly from?: string | undefined; readonly to?: string | undefined };

function isPeriodOrdered({ from, to }: PeriodBounds): boolean {
  return from === undefined || to === undefined || Date.parse(from) <= Date.parse(to);
}
const PERIOD_ISSUE = { message: 'from doit précéder to', path: ['from'] };

export const auditLogFiltersSchema = z.object(auditLogFilterShape).refine(isPeriodOrdered, PERIOD_ISSUE);
export type AuditLogFilters = z.infer<typeof auditLogFiltersSchema>;

export const listAuditLogsQuerySchema = z
  .object({
    ...auditLogFilterShape,
    limit: z.coerce.number().int().min(1).max(AUDIT_LIST_MAX_LIMIT).default(AUDIT_LIST_DEFAULT_LIMIT),
    cursor: z.string().max(CURSOR_MAX_LENGTH).optional(),
  })
  .refine(isPeriodOrdered, PERIOD_ISSUE);
export type ListAuditLogsQuery = z.infer<typeof listAuditLogsQuerySchema>;

export const exportAuditLogsSchema = auditLogFiltersSchema;
export type ExportAuditLogsInput = AuditLogFilters;

export const verifyAuditChainQuerySchema = z.object({
  limit: z.coerce.number().int().min(AUDIT_VERIFY_MIN_LIMIT).max(AUDIT_VERIFY_MAX_LIMIT).default(AUDIT_VERIFY_MAX_LIMIT),
});
export type VerifyAuditChainQuery = z.infer<typeof verifyAuditChainQuerySchema>;

export const dashboardQuerySchema = z.object({ siteId: uuid.optional() });
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

// ───────── Vues ─────────
export interface AuditLogView {
  readonly id: string;
  /** `chain_seq` en chaîne (entier 64 bits). */
  readonly seq: string;
  readonly occurredAt: string;
  readonly actor: { readonly type: string; readonly userId: string | null; readonly fullName: string | null };
  readonly action: string;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly patientId: string | null;
  readonly outcome: AuditOutcomeValue;
  readonly ip: string | null;
  readonly requestId: string | null;
  /** Assaini : aucune donnée clinique ni libre (docs/10 §6). */
  readonly changes: Readonly<Record<string, unknown>> | null;
}

export type AuditChainStatus = 'intact' | 'broken' | 'empty';

export interface AuditChainVerificationView {
  readonly status: AuditChainStatus;
  readonly checkedCount: number;
  readonly fromSeq: string | null;
  readonly toSeq: string | null;
  readonly firstBrokenSeq: string | null;
  readonly checkedAt: string;
}

export type PaymentMethodTotals = Readonly<Record<PaymentMethod, string>>;

export interface DashboardOpenCashSession {
  readonly id: string;
  readonly registerCode: string;
  readonly siteId: string;
  readonly openedAt: string;
  readonly openedBy: { readonly id: string; readonly fullName: string };
}

export interface EstablishmentDashboardView {
  /** Jour calendaire du fuseau du tenant (AAAA-MM-JJ). */
  readonly date: string;
  readonly timezone: string;
  readonly generatedAt: string;
  readonly siteId: string | null;
  readonly patients: { readonly total: number; readonly registeredToday: number } | null;
  readonly appointments: { readonly total: number; readonly byStatus: Readonly<Record<AppointmentStatus, number>> } | null;
  readonly revenue: { readonly currency: string; readonly total: string; readonly byMethod: PaymentMethodTotals } | null;
  readonly cashSessions: { readonly openCount: number; readonly items: readonly DashboardOpenCashSession[] } | null;
}
