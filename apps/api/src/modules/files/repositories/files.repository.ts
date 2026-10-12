import { Injectable } from '@nestjs/common';
import type { FileRejectReason, Prisma, StoredFile } from '../../../generated/prisma/client';
import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';

/** Documents listés dans la fiche patient (docs/13 §5). */
export const MAX_LISTED_DOCUMENTS = 100;
/** Statuts comptés dans le quota et visibles dans la fiche patient. */
const LIVE_STATUSES = ['pending', 'available'] as const;

export type FileRow = StoredFile;

/** Accès Prisma aux fichiers. Chaque méthode s'exécute dans la transaction RLS du tenant. */
@Injectable()
export class FilesRepository {
  async patientExists(tx: TenantTx, tenantId: string, patientId: string, scope: Prisma.PatientWhereInput): Promise<boolean> {
    const row = await tx.patient.findFirst({ where: { tenantId, id: patientId, deletedAt: null, mergedIntoPatientId: null, AND: [scope] }, select: { id: true } });
    return row !== null;
  }

  /** Sites des services donnés (une portée « service » couvre les patients du site du service). */
  async siteIdsOfDepartments(tx: TenantTx, tenantId: string, departmentIds: readonly string[]): Promise<string[]> {
    if (departmentIds.length === 0) return [];
    const rows = await tx.department.findMany({ where: { tenantId, id: { in: [...departmentIds] } }, select: { siteId: true } });
    return rows.map((row) => row.siteId);
  }

  /** Verrou d'avis transactionnel du quota : deux dépôts simultanés ne dépassent pas la limite. */
  async lockStorageQuota(tx: TenantTx): Promise<void> {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended('plan-limit:storage:' || current_setting('app.tenant_id', true), 0))`;
  }

  async usedBytes(tx: TenantTx, tenantId: string): Promise<number> {
    const result = await tx.storedFile.aggregate({ where: { tenantId, status: { in: [...LIVE_STATUSES] } }, _sum: { sizeBytes: true } });
    return Number(result._sum.sizeBytes ?? 0n);
  }

  create(tx: TenantTx, data: Prisma.StoredFileUncheckedCreateInput): Promise<FileRow> {
    return tx.storedFile.create({ data });
  }

  /** Suppression physique d'une ligne `pending` dont l'objet n'a jamais pu être écrit (stockage indisponible). */
  async discardPending(tx: TenantTx, tenantId: string, id: string): Promise<void> {
    await tx.storedFile.deleteMany({ where: { tenantId, id, status: 'pending' } });
  }

  /** Transitions depuis `pending` uniquement : la première issue gagne (dépôt et tâche de reprise concurrents). */
  async markAvailable(tx: TenantTx, tenantId: string, id: string, now: Date): Promise<boolean> {
    const result = await tx.storedFile.updateMany({
      where: { tenantId, id, status: 'pending' },
      data: { status: 'available', availableAt: now, scanAttempts: { increment: 1 } },
    });
    return result.count === 1;
  }

  async markRejected(tx: TenantTx, tenantId: string, id: string, reason: FileRejectReason, countAttempt: boolean): Promise<boolean> {
    const result = await tx.storedFile.updateMany({
      where: { tenantId, id, status: 'pending' },
      data: { status: 'rejected', rejectReason: reason, ...(countAttempt ? { scanAttempts: { increment: 1 } } : {}) },
    });
    return result.count === 1;
  }

  async recordFailedScan(tx: TenantTx, tenantId: string, id: string): Promise<void> {
    await tx.storedFile.updateMany({ where: { tenantId, id, status: 'pending' }, data: { scanAttempts: { increment: 1 } } });
  }

  listForPatient(tx: TenantTx, tenantId: string, patientId: string): Promise<FileRow[]> {
    return tx.storedFile.findMany({
      where: { tenantId, patientId, status: { in: [...LIVE_STATUSES] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MAX_LISTED_DOCUMENTS,
    });
  }

  findForPatient(tx: TenantTx, tenantId: string, patientId: string, id: string, statuses: readonly FileRow['status'][]): Promise<FileRow | null> {
    return tx.storedFile.findFirst({ where: { tenantId, patientId, id, status: { in: [...statuses] } } });
  }

  /** Suppression avec effacement cryptographique : la clé de données enveloppée est détruite (la base l'impose, ck_files_crypto_erase). */
  async markDeleted(tx: TenantTx, tenantId: string, id: string, now: Date): Promise<boolean> {
    const result = await tx.storedFile.updateMany({
      where: { tenantId, id, status: { in: [...LIVE_STATUSES] } },
      data: { status: 'deleted', deletedAt: now, wrappedKey: null },
    });
    return result.count === 1;
  }

  async statusOf(tx: TenantTx, tenantId: string, id: string): Promise<FileRow['status'] | null> {
    const row = await tx.storedFile.findFirst({ where: { tenantId, id }, select: { status: true } });
    return row?.status ?? null;
  }

  async userNames(tx: TenantTx, tenantId: string, userIds: readonly string[]): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    const users = await tx.user.findMany({ where: { tenantId, id: { in: [...new Set(userIds)] } }, select: { id: true, fullName: true } });
    return new Map(users.map((user) => [user.id, user.fullName]));
  }

  /** Fichiers `pending` déposés avant `createdBefore` (reprise de l'analyse), les plus anciens d'abord. */
  pendingCreatedBefore(tx: TenantTx, tenantId: string, createdBefore: Date, take: number): Promise<FileRow[]> {
    return tx.storedFile.findMany({ where: { tenantId, status: 'pending', createdAt: { lte: createdBefore } }, orderBy: { createdAt: 'asc' }, take });
  }
}
