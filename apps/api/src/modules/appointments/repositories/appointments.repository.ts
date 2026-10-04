import { Injectable } from '@nestjs/common';
import type { AppointmentStatus, Prisma } from '../../../generated/prisma/client';
import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import type { PermissionScope } from '../domain/appointment-scope';
import { APPOINTMENT_INCLUDE, type AppointmentRow } from '../mappers/appointment.mapper';
import type { PractitionerRow } from '../mappers/practitioner.mapper';

export interface AppointmentListCriteria {
  readonly from: Date;
  readonly to: Date;
  readonly practitionerId?: string;
  readonly siteId?: string;
  readonly patientId?: string;
  readonly status?: AppointmentStatus;
  readonly scope: PermissionScope;
  readonly after?: { readonly startsAt: Date; readonly id: string };
  readonly take: number;
}

/** Restreint la requête aux sites / services couverts par la portée (aucun filtre si tout le tenant). */
function scopeFilter(scope: PermissionScope): Prisma.AppointmentWhereInput {
  if (scope.allTenant) return {};
  return {
    OR: [
      { siteId: { in: [...scope.siteIds] } },
      ...(scope.departmentIds.length > 0 ? [{ practitioner: { departmentId: { in: [...scope.departmentIds] } } }] : []),
    ],
  };
}

@Injectable()
export class AppointmentsRepository {
  create(tx: TenantTx, data: Prisma.AppointmentUncheckedCreateInput): Promise<AppointmentRow> {
    return tx.appointment.create({ data, include: APPOINTMENT_INCLUDE });
  }

  findById(tx: TenantTx, tenantId: string, id: string): Promise<AppointmentRow | null> {
    return tx.appointment.findFirst({ where: { tenantId, id, deletedAt: null }, include: APPOINTMENT_INCLUDE });
  }

  list(tx: TenantTx, tenantId: string, c: AppointmentListCriteria): Promise<AppointmentRow[]> {
    const and: Prisma.AppointmentWhereInput[] = [scopeFilter(c.scope)];
    if (c.after) {
      and.push({ OR: [{ startsAt: { gt: c.after.startsAt } }, { startsAt: c.after.startsAt, id: { gt: c.after.id } }] });
    }
    return tx.appointment.findMany({
      where: {
        tenantId,
        deletedAt: null,
        startsAt: { lt: c.to },
        endsAt: { gt: c.from },
        ...(c.practitionerId ? { practitionerId: c.practitionerId } : {}),
        ...(c.siteId ? { siteId: c.siteId } : {}),
        ...(c.patientId ? { patientId: c.patientId } : {}),
        ...(c.status ? { status: c.status } : {}),
        AND: and,
      },
      include: APPOINTMENT_INCLUDE,
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      take: c.take,
    });
  }

  /** Mise à jour gardée par le statut lu : une modification concurrente donne 0 ligne. */
  async updateGuarded(
    tx: TenantTx,
    tenantId: string,
    id: string,
    expectedStatus: AppointmentStatus,
    data: Prisma.AppointmentUncheckedUpdateManyInput,
  ): Promise<number> {
    const result = await tx.appointment.updateMany({
      where: { tenantId, id, status: expectedStatus, deletedAt: null },
      data: { ...data, rowVersion: { increment: 1 } },
    });
    return result.count;
  }

  async softDelete(tx: TenantTx, tenantId: string, id: string, userId: string): Promise<number> {
    const result = await tx.appointment.updateMany({
      where: { tenantId, id, deletedAt: null },
      data: { deletedAt: new Date(), updatedBy: userId, rowVersion: { increment: 1 } },
    });
    return result.count;
  }

  findPractitioner(tx: TenantTx, tenantId: string, id: string): Promise<PractitionerRow | null> {
    return tx.practitioner.findFirst({ where: { tenantId, id, deletedAt: null } });
  }

  /** Patient existant ET visible du demandeur (`patientScope` = filtre de périmètre de patients:patient:read). */
  findPatient(
    tx: TenantTx,
    tenantId: string,
    id: string,
    patientScope: Prisma.PatientWhereInput,
  ): Promise<{ id: string; deceasedAt: Date | null } | null> {
    return tx.patient.findFirst({ where: { tenantId, id, deletedAt: null, AND: [patientScope] }, select: { id: true, deceasedAt: true } });
  }

  /** Sites des services donnés (une portée « service » couvre les patients du site du service). */
  async siteIdsOfDepartments(tx: TenantTx, tenantId: string, departmentIds: readonly string[]): Promise<string[]> {
    if (departmentIds.length === 0) return [];
    const rows = await tx.department.findMany({ where: { tenantId, id: { in: [...departmentIds] } }, select: { siteId: true } });
    return rows.map((row) => row.siteId);
  }

  async siteExists(tx: TenantTx, tenantId: string, id: string): Promise<boolean> {
    return (await tx.site.count({ where: { tenantId, id, deletedAt: null } })) > 0;
  }
}
