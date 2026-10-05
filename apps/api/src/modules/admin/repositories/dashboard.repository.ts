import { Injectable } from '@nestjs/common';
import type { AppointmentStatus, PaymentMethod } from '@ghmt/shared';
import type { Prisma } from '../../../generated/prisma/client';
import type { Money } from '../../../common/money/money';
import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';

export interface OpenSessionRow {
  readonly id: string;
  readonly openedBy: string;
  readonly openedAt: Date;
  readonly register: { readonly code: string; readonly siteId: string };
}

/** Lectures agrégées du tableau de bord : uniquement des comptes et des sommes, aucune colonne nominative de patient. */
@Injectable()
export class DashboardRepository {
  async siteExists(tx: TenantTx, tenantId: string, siteId: string): Promise<boolean> {
    return (await tx.site.count({ where: { tenantId, id: siteId, deletedAt: null } })) > 0;
  }

  async siteIdsOfDepartments(tx: TenantTx, tenantId: string, departmentIds: readonly string[]): Promise<string[]> {
    if (departmentIds.length === 0) return [];
    const rows = await tx.department.findMany({ where: { tenantId, id: { in: [...departmentIds] } }, select: { siteId: true } });
    return rows.map((row) => row.siteId);
  }

  countPatients(tx: TenantTx, where: Prisma.PatientWhereInput): Promise<number> {
    return tx.patient.count({ where });
  }

  async countAppointmentsByStatus(tx: TenantTx, where: Prisma.AppointmentWhereInput): Promise<Map<AppointmentStatus, number>> {
    const groups = await tx.appointment.groupBy({ by: ['status'], where, _count: { _all: true } });
    return new Map(groups.map((group) => [group.status, group._count._all]));
  }

  async sumPaymentsByMethod(tx: TenantTx, where: Prisma.PatientPaymentWhereInput): Promise<Map<PaymentMethod, Money>> {
    const groups = await tx.patientPayment.groupBy({ by: ['method'], where, _sum: { amount: true } });
    return new Map(groups.flatMap((group) => (group._sum.amount ? [[group.method as PaymentMethod, group._sum.amount] as const] : [])));
  }

  countOpenSessions(tx: TenantTx, where: Prisma.CashSessionWhereInput): Promise<number> {
    return tx.cashSession.count({ where });
  }

  listOpenSessions(tx: TenantTx, where: Prisma.CashSessionWhereInput, take: number): Promise<OpenSessionRow[]> {
    return tx.cashSession.findMany({
      where,
      orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
      take,
      select: { id: true, openedBy: true, openedAt: true, register: { select: { code: true, siteId: true } } },
    });
  }

  async userNames(tx: TenantTx, tenantId: string, ids: readonly string[]): Promise<ReadonlyMap<string, string>> {
    if (ids.length === 0) return new Map();
    const users = await tx.user.findMany({ where: { tenantId, id: { in: [...new Set(ids)] } }, select: { id: true, fullName: true } });
    return new Map(users.map((user) => [user.id, user.fullName]));
  }
}
