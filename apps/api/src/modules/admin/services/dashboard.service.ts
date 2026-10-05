import { Injectable } from '@nestjs/common';
import type { DashboardOpenCashSession, DashboardQuery, EstablishmentDashboardView, PermissionKey } from '@ghmt/shared';
import { AuthorizationService } from '../../../common/authz/authorization.service';
import { RequestContext } from '../../../common/context/request-context';
import { DomainError } from '../../../common/errors/domain-error';
import { Clock } from '../../../common/time/clock';
import { loadTenantProfile } from '../../../infrastructure/tenancy/tenant-profile';
import { TenantDb, type TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import {
  appointmentWhere,
  openSessionWhere,
  patientWhere,
  paymentWhere,
  registeredTodayWhere,
  type DayRange,
} from '../domain/dashboard-filters';
import { SECTION_PERMISSIONS, mergedScope, resolveDashboardSections, type MergedScope } from '../domain/dashboard-sections';
import { dayBounds } from '../domain/day-bounds';
import { toMethodTotals, toStatusCounts } from '../mappers/dashboard.mapper';
import { DashboardRepository } from '../repositories/dashboard.repository';

const MAX_LISTED_SESSIONS = 50;

interface SectionContext {
  readonly tx: TenantTx;
  readonly tenantId: string;
  readonly siteId: string | undefined;
  readonly day: DayRange;
  readonly currency: string;
}

/** Tableau de bord de l'établissement : comptes et sommes seulement, sections filtrées par permission, module et portée. */
@Injectable()
export class DashboardService {
  constructor(
    private readonly db: TenantDb,
    private readonly repo: DashboardRepository,
    private readonly authz: AuthorizationService,
    private readonly context: RequestContext,
    private readonly clock: Clock,
  ) {}

  establishment(query: DashboardQuery): Promise<EstablishmentDashboardView> {
    const { tenantId } = this.context.requirePrincipal();
    const now = this.clock.now();
    return this.db.run(async (tx) => {
      if (query.siteId && !(await this.repo.siteExists(tx, tenantId, query.siteId))) {
        throw DomainError.validation([{ path: 'siteId', code: 'not_found', message: 'Site introuvable.' }]);
      }
      const profile = await loadTenantProfile(tx);
      const { modules } = await this.authz.loadTenantModules(tx);
      const sections = resolveDashboardSections(this.context.grants, modules);
      const day = dayBounds(now, profile.timezone);
      const section: SectionContext = { tx, tenantId, siteId: query.siteId, day, currency: profile.baseCurrency };
      return {
        date: day.date,
        timezone: profile.timezone,
        generatedAt: now.toISOString(),
        siteId: query.siteId ?? null,
        patients: sections.patients ? await this.patients(section) : null,
        appointments: sections.appointments ? await this.appointments(section) : null,
        revenue: sections.revenue ? await this.revenue(section) : null,
        cashSessions: sections.cashSessions ? await this.cashSessions(section) : null,
      };
    });
  }

  private scopeOf(permissions: readonly PermissionKey[]): MergedScope {
    return mergedScope(this.context.grants, permissions);
  }

  private departmentSites(ctx: SectionContext, scope: MergedScope): Promise<string[]> {
    return scope.allTenant ? Promise.resolve([]) : this.repo.siteIdsOfDepartments(ctx.tx, ctx.tenantId, scope.departmentIds);
  }

  private async patients(ctx: SectionContext): Promise<NonNullable<EstablishmentDashboardView['patients']>> {
    const scope = this.scopeOf(SECTION_PERMISSIONS.patients);
    const where = patientWhere(ctx.tenantId, scope, await this.departmentSites(ctx, scope), ctx.siteId);
    return {
      total: await this.repo.countPatients(ctx.tx, where),
      registeredToday: await this.repo.countPatients(ctx.tx, registeredTodayWhere(where, ctx.day)),
    };
  }

  private async appointments(ctx: SectionContext): Promise<NonNullable<EstablishmentDashboardView['appointments']>> {
    const where = appointmentWhere(ctx.tenantId, this.scopeOf(SECTION_PERMISSIONS.appointments), ctx.day, ctx.siteId);
    const byStatus = toStatusCounts(await this.repo.countAppointmentsByStatus(ctx.tx, where));
    return { total: Object.values(byStatus).reduce((sum, count) => sum + count, 0), byStatus };
  }

  private async revenue(ctx: SectionContext): Promise<NonNullable<EstablishmentDashboardView['revenue']>> {
    const scope = this.scopeOf(SECTION_PERMISSIONS.revenue);
    const where = paymentWhere(ctx.tenantId, scope, await this.departmentSites(ctx, scope), ctx.day, ctx.siteId, ctx.currency);
    return { currency: ctx.currency, ...toMethodTotals(await this.repo.sumPaymentsByMethod(ctx.tx, where)) };
  }

  private async cashSessions(ctx: SectionContext): Promise<NonNullable<EstablishmentDashboardView['cashSessions']>> {
    const scope = this.scopeOf(SECTION_PERMISSIONS.cashSessions);
    const where = openSessionWhere(ctx.tenantId, scope, await this.departmentSites(ctx, scope), ctx.siteId);
    const [openCount, rows] = await Promise.all([this.repo.countOpenSessions(ctx.tx, where), this.repo.listOpenSessions(ctx.tx, where, MAX_LISTED_SESSIONS)]);
    const names = await this.repo.userNames(ctx.tx, ctx.tenantId, rows.map((row) => row.openedBy));
    const items: DashboardOpenCashSession[] = rows.map((row) => ({
      id: row.id,
      registerCode: row.register.code,
      siteId: row.register.siteId,
      openedAt: row.openedAt.toISOString(),
      openedBy: { id: row.openedBy, fullName: names.get(row.openedBy) ?? '' },
    }));
    return { openCount, items };
  }
}
