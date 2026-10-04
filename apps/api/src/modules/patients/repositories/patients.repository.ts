import { Injectable } from '@nestjs/common';
import type { AppointmentStatus, Prisma } from '../../../generated/prisma/client';
import type { Bytes } from '../../../common/crypto/field-crypto.service';
import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { DUPLICATE_CANDIDATE_SELECT, type DuplicateCandidateRow, type PatientRow } from '../mappers/patient.mapper';

export const MAX_DUPLICATE_CANDIDATES = 5;

export interface DuplicateCriteria {
  /** Formes normalisées du nom (« nom prénom » et « prénom nom »). */
  readonly nameKeys: readonly string[];
  readonly birthDate?: Date;
  /** Date saisie comme estimée : toute naissance à ± 2 ans compte. */
  readonly birthDateEstimated: boolean;
  readonly birthYearWindow?: { readonly from: Date; readonly to: Date };
  readonly phoneBidx?: Bytes;
  readonly nationalIdBidx?: Bytes;
}

/** Nombre maximal d'identifiants hors périmètre consignés dans l'audit d'un doublon masqué. */
export const MAX_AUDITED_HIDDEN_MATCHES = 20;

/** Rendez-vous sans suite possible : non annulables à la suppression du dossier. */
const FINAL_APPOINTMENT_STATUSES: AppointmentStatus[] = ['completed', 'cancelled', 'no_show'];

export interface DuplicateMatches {
  /** Correspondances visibles de l'appelant (périmètre appliqué), 5 au plus. */
  readonly visible: readonly DuplicateCandidateRow[];
  /**
   * Identifiants des correspondances hors périmètre, renseignés seulement quand aucune n'est visible
   * (usage : audit uniquement, jamais renvoyés au client).
   */
  readonly hiddenIds: readonly string[];
}

export interface PatientSearchCriteria {
  readonly namePattern?: string;
  readonly phoneBidx?: Bytes;
  readonly ipp?: string;
  readonly afterId?: string;
  readonly take: number;
  readonly scope: Prisma.PatientWhereInput;
}

/** Accès Prisma aux patients. Chaque méthode s'exécute dans la transaction RLS du tenant. */
@Injectable()
export class PatientsRepository {
  async nextIppSequence(tx: TenantTx): Promise<bigint> {
    const [{ seq }] = await tx.$queryRaw<{ seq: bigint }[]>`SELECT tenant.next_sequence('ipp') AS seq`;
    return seq;
  }

  create(tx: TenantTx, data: Prisma.PatientUncheckedCreateInput): Promise<PatientRow> {
    return tx.patient.create({ data });
  }

  findById(tx: TenantTx, tenantId: string, id: string, scope: Prisma.PatientWhereInput): Promise<PatientRow | null> {
    return tx.patient.findFirst({ where: { tenantId, id, deletedAt: null, AND: [scope] } });
  }

  async findDuplicates(tx: TenantTx, tenantId: string, criteria: DuplicateCriteria, scope: Prisma.PatientWhereInput): Promise<DuplicateMatches> {
    const alternatives = this.duplicateAlternatives(criteria);
    if (alternatives.length === 0) return { visible: [], hiddenIds: [] };
    const base: Prisma.PatientWhereInput = { tenantId, deletedAt: null, mergedIntoPatientId: null, OR: alternatives };
    const visible = await tx.patient.findMany({ where: { ...base, AND: [scope] }, select: DUPLICATE_CANDIDATE_SELECT, orderBy: { id: 'asc' }, take: MAX_DUPLICATE_CANDIDATES });
    if (visible.length > 0) return { visible, hiddenIds: [] };
    const hidden = await tx.patient.findMany({ where: base, select: { id: true }, orderBy: { id: 'asc' }, take: MAX_AUDITED_HIDDEN_MATCHES });
    return { visible, hiddenIds: hidden.map((row) => row.id) };
  }

  /**
   * Annule les rendez-vous futurs non terminés d'un patient (suppression du dossier).
   * Renvoie les identifiants annulés, pour l'audit.
   */
  async cancelFutureAppointments(tx: TenantTx, tenantId: string, patientId: string, now: Date, userId: string, cancelReason: string): Promise<string[]> {
    const where: Prisma.AppointmentWhereInput = { tenantId, patientId, deletedAt: null, startsAt: { gt: now }, status: { notIn: FINAL_APPOINTMENT_STATUSES } };
    const rows = await tx.appointment.findMany({ where, select: { id: true }, orderBy: { id: 'asc' } });
    if (rows.length === 0) return [];
    await tx.appointment.updateMany({
      where: { ...where, id: { in: rows.map((row) => row.id) } },
      data: { status: 'cancelled', cancelReason, updatedBy: userId, rowVersion: { increment: 1 } },
    });
    return rows.map((row) => row.id);
  }

  search(tx: TenantTx, tenantId: string, criteria: PatientSearchCriteria): Promise<PatientRow[]> {
    const where: Prisma.PatientWhereInput = {
      tenantId,
      deletedAt: null,
      ...(criteria.namePattern ? { searchName: { contains: criteria.namePattern, mode: 'insensitive' } } : {}),
      ...(criteria.phoneBidx ? { phoneBidx: criteria.phoneBidx } : {}),
      ...(criteria.ipp ? { ipp: criteria.ipp } : {}),
      ...(criteria.afterId ? { id: { gt: criteria.afterId } } : {}),
      AND: [criteria.scope],
    };
    return tx.patient.findMany({ where, orderBy: { id: 'asc' }, take: criteria.take });
  }

  /** Mise à jour conditionnelle sur la version lue (concurrence optimiste). Renvoie le nombre de lignes. */
  async update(
    tx: TenantTx,
    tenantId: string,
    id: string,
    expectedVersion: number,
    data: Prisma.PatientUncheckedUpdateManyInput,
  ): Promise<number> {
    const result = await tx.patient.updateMany({
      where: { tenantId, id, deletedAt: null, rowVersion: expectedVersion },
      data: { ...data, rowVersion: { increment: 1 } },
    });
    return result.count;
  }

  async softDelete(tx: TenantTx, tenantId: string, id: string, expectedVersion: number, userId: string): Promise<number> {
    const result = await tx.patient.updateMany({
      where: { tenantId, id, deletedAt: null, rowVersion: expectedVersion },
      data: { deletedAt: new Date(), updatedBy: userId, rowVersion: { increment: 1 } },
    });
    return result.count;
  }

  async siteExists(tx: TenantTx, tenantId: string, siteId: string): Promise<boolean> {
    return (await tx.site.count({ where: { tenantId, id: siteId, deletedAt: null } })) > 0;
  }

  /** Sites des services donnés (une portée « service » couvre les patients du site du service). */
  async siteIdsOfDepartments(tx: TenantTx, tenantId: string, departmentIds: readonly string[]): Promise<string[]> {
    if (departmentIds.length === 0) return [];
    const rows = await tx.department.findMany({ where: { tenantId, id: { in: [...departmentIds] } }, select: { siteId: true } });
    return rows.map((row) => row.siteId);
  }

  private duplicateAlternatives(c: DuplicateCriteria): Prisma.PatientWhereInput[] {
    const alternatives: Prisma.PatientWhereInput[] = [];
    const sameName: Prisma.PatientWhereInput = { searchName: { in: [...c.nameKeys] } };
    if (!c.birthDate) {
      // Sans date de naissance saisie : tout homonyme (daté ou non) est un candidat.
      alternatives.push(sameName);
    } else if (c.birthYearWindow) {
      // Homonyme dont la fiche n'a pas de date de naissance : candidat « nom seul ».
      alternatives.push({ ...sameName, birthDate: null });
      const window = { gte: c.birthYearWindow.from, lte: c.birthYearWindow.to };
      if (c.birthDateEstimated) {
        alternatives.push({ ...sameName, birthDate: window });
      } else {
        alternatives.push({ ...sameName, birthDate: c.birthDate });
        // Une fiche existante à date estimée peut dater de ± 2 ans.
        alternatives.push({ ...sameName, birthDateEstimated: true, birthDate: window });
      }
    }
    if (c.phoneBidx) alternatives.push({ phoneBidx: c.phoneBidx });
    if (c.nationalIdBidx) alternatives.push({ nationalIdBidx: c.nationalIdBidx });
    return alternatives;
  }
}
