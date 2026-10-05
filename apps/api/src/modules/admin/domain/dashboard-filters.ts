import type { Prisma } from '../../../generated/prisma/client';
import { buildSiteScopeFilter } from '../../billing/domain/billing-scope';
import { buildPatientScopeFilter } from '../../patients/domain/patient-scope';
import type { MergedScope } from './dashboard-sections';

export interface DayRange {
  readonly start: Date;
  readonly end: Date;
}

/** Sites visibles d'une portée (`undefined` = tout l'établissement) : sites de la portée et sites de ses services. */
function visibleSites(scope: MergedScope, departmentSiteIds: readonly string[]): string[] | undefined {
  return buildSiteScopeFilter(scope, departmentSiteIds).siteId?.in;
}

/** Condition `siteId` combinant la portée (si restreinte) et le site demandé ; un site hors portée ne couvre rien. */
function siteCondition(scope: MergedScope, departmentSiteIds: readonly string[], siteId: string | undefined): { siteId?: string | { in: string[] } } {
  const allowed = visibleSites(scope, departmentSiteIds);
  if (siteId === undefined) return allowed === undefined ? {} : { siteId: { in: allowed } };
  return allowed === undefined || allowed.includes(siteId) ? { siteId } : { siteId: { in: [] } };
}

/** Patients non supprimés de la portée ; `primarySiteId` NULL reste visible hors filtre de site (règle de `patient-scope`). */
export function patientWhere(tenantId: string, scope: MergedScope, departmentSiteIds: readonly string[], siteId: string | undefined): Prisma.PatientWhereInput {
  return {
    tenantId,
    deletedAt: null,
    AND: [buildPatientScopeFilter(scope, departmentSiteIds), ...(siteId ? [{ primarySiteId: siteId }] : [])],
  };
}

export function registeredTodayWhere(base: Prisma.PatientWhereInput, day: DayRange): Prisma.PatientWhereInput {
  return { ...base, createdAt: { gte: day.start, lt: day.end } };
}

/** Rendez-vous du jour non supprimés ; portée de rendez-vous : site, ou service du praticien. */
export function appointmentWhere(tenantId: string, scope: MergedScope, day: DayRange, siteId: string | undefined): Prisma.AppointmentWhereInput {
  const restricted: Prisma.AppointmentWhereInput = scope.allTenant
    ? {}
    : { OR: [{ siteId: { in: [...scope.siteIds] } }, { practitioner: { departmentId: { in: [...scope.departmentIds] } } }] };
  return { tenantId, deletedAt: null, startsAt: { gte: day.start, lt: day.end }, ...(siteId ? { siteId } : {}), AND: [restricted] };
}

/** Paiements abouti dans la journée (`paid_at`), dans la devise de l'établissement, sur les factures des sites visibles. */
export function paymentWhere(
  tenantId: string,
  scope: MergedScope,
  departmentSiteIds: readonly string[],
  day: DayRange,
  siteId: string | undefined,
  currency: string,
): Prisma.PatientPaymentWhereInput {
  return {
    tenantId,
    status: 'succeeded',
    currency,
    paidAt: { gte: day.start, lt: day.end },
    invoice: siteCondition(scope, departmentSiteIds, siteId),
  };
}

export function openSessionWhere(tenantId: string, scope: MergedScope, departmentSiteIds: readonly string[], siteId: string | undefined): Prisma.CashSessionWhereInput {
  return { tenantId, status: 'open', register: siteCondition(scope, departmentSiteIds, siteId) };
}
