import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../../common/audit/audit.service';
import type { AuditEvent } from '../../../common/audit/audit.types';
import { Clock } from '../../../common/time/clock';
import { ENV, type Env } from '../../../infrastructure/config/env';
import { TenantDb, type TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { ANTIVIRUS, AntivirusUnavailableError, type Antivirus, type ScanVerdict } from '../../../infrastructure/storage/clamav-scanner';
import { OBJECT_STORAGE, type ObjectStorage } from '../../../infrastructure/storage/object-storage';
import { StorageUnavailableError } from '../../../infrastructure/storage/storage-errors';
import type { FileRejectReason } from '../../../generated/prisma/client';
import { FilesRepository, type FileRow } from '../repositories/files.repository';

/** Origine de l'analyse : dépôt par un utilisateur, ou reprise par la tâche planifiée (acteur système). */
export type ScanOrigin = { readonly kind: 'upload'; readonly userId: string } | { readonly kind: 'retry' };

export type ScanOutcome =
  | { readonly status: 'available' }
  | { readonly status: 'pending'; readonly cause: 'antivirus_unavailable' | 'storage_unavailable' }
  | { readonly status: 'rejected'; readonly reason: FileRejectReason }
  /** Le fichier n'était plus `pending` (issue déjà fixée par un traitement concurrent, ou supprimé). */
  | { readonly status: 'unchanged' };

/**
 * Quarantaine et analyse (docs/13 D5) : l'objet chiffré est d'abord en `quarantine` ; sain, il est copié vers `documents`
 * (statut `available`) ; infecté, il est supprimé (statut `rejected`) ; antivirus indisponible, il reste `pending`.
 * Chaque issue est écrite avec son audit dans la même transaction.
 */
@Injectable()
export class FileQuarantineService {
  private readonly logger = new Logger(FileQuarantineService.name);

  constructor(
    private readonly db: TenantDb,
    private readonly repo: FilesRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage | null,
    @Inject(ANTIVIRUS) private readonly antivirus: Antivirus,
  ) {}

  get quarantineBucket(): string {
    return this.env.S3_BUCKET_QUARANTINE;
  }

  get documentsBucket(): string {
    return this.env.S3_BUCKET_DOCUMENTS;
  }

  /** Analyse le contenu en clair de `file` (déjà écrit chiffré en quarantaine) et fixe son issue. */
  async scanAndSettle(file: FileRow, plaintext: Buffer, origin: ScanOrigin): Promise<ScanOutcome> {
    let verdict: ScanVerdict;
    try {
      verdict = await this.antivirus.scan(plaintext);
    } catch (error) {
      if (!(error instanceof AntivirusUnavailableError)) throw error;
      this.logger.warn({ fileId: file.id }, 'Antivirus indisponible : document laissé en attente d’analyse');
      await this.keepPending(file, origin);
      return { status: 'pending', cause: 'antivirus_unavailable' };
    }
    if (verdict.status === 'infected') return this.reject(file, 'infected', origin, { signature: verdict.signature });
    return this.promote(file, origin);
  }

  /** Signature détectée dans un contenu qui ne sera pas stocké (type refusé) ; antivirus indisponible ⇒ `undefined`. */
  async detectInfection(content: Buffer): Promise<string | undefined> {
    try {
      const verdict = await this.antivirus.scan(content);
      return verdict.status === 'infected' ? verdict.signature : undefined;
    } catch (error) {
      if (error instanceof AntivirusUnavailableError) return undefined;
      throw error;
    }
  }

  /** Rejet d'un fichier `pending` : objet de quarantaine supprimé, statut `rejected`, audit `files.file.rejected`. */
  async reject(file: FileRow, reason: FileRejectReason, origin: ScanOrigin, extra: Record<string, unknown> = {}): Promise<ScanOutcome> {
    await this.deleteQuietly(file.id, this.quarantineBucket, file.objectKey);
    const changed = await this.inTx(file, origin, async (tx) => {
      if (!(await this.repo.markRejected(tx, file.tenantId, file.id, reason, reason === 'infected'))) return false;
      await this.audit.record(tx, file.tenantId, this.event(file, origin, 'files.file.rejected', { reason, ...extra }));
      return true;
    });
    return changed ? { status: 'rejected', reason } : { status: 'unchanged' };
  }

  private async promote(file: FileRow, origin: ScanOrigin): Promise<ScanOutcome> {
    const storage = this.requireStorage();
    try {
      await storage.copy({ bucket: this.quarantineBucket, key: file.objectKey }, { bucket: this.documentsBucket, key: file.objectKey });
    } catch (error) {
      if (!(error instanceof StorageUnavailableError)) throw error;
      await this.keepPending(file, origin);
      return { status: 'pending', cause: 'storage_unavailable' };
    }
    const changed = await this.inTx(file, origin, async (tx) => {
      if (!(await this.repo.markAvailable(tx, file.tenantId, file.id, this.clock.now()))) return false;
      const action = origin.kind === 'upload' ? 'files.file.uploaded' : 'files.file.available';
      await this.audit.record(tx, file.tenantId, this.event(file, origin, action, this.uploadSummary(file, 'available')));
      return true;
    });
    // La copie vers `documents` fait foi : l'objet de quarantaine n'est plus utile, quelle que soit l'issue.
    if (changed) {
      await this.deleteQuietly(file.id, this.quarantineBucket, file.objectKey);
      return { status: 'available' };
    }
    await this.discardPromotedCopyIfDeleted(file, origin);
    return { status: 'unchanged' };
  }

  /**
   * Course avec une suppression : le fichier est passé à `deleted` pendant la copie vers `documents`. La copie (et l'objet de
   * quarantaine, si la suppression ne l'a pas retiré) est supprimée. Un autre statut (ex. `available` posé par un traitement
   * concurrent qui a copié le même objet) laisse la copie en place : elle est alors la bonne.
   */
  private async discardPromotedCopyIfDeleted(file: FileRow, origin: ScanOrigin): Promise<void> {
    const status = await this.inTx(file, origin, (tx) => this.repo.statusOf(tx, file.tenantId, file.id));
    if (status === 'deleted') await this.deleteObjectsQuietly(file.id, file.objectKey);
  }

  /** Échec d'analyse : tentative comptée ; au dépôt, l'audit `files.file.uploaded` porte le statut `pending`. */
  private async keepPending(file: FileRow, origin: ScanOrigin): Promise<void> {
    await this.inTx(file, origin, async (tx) => {
      await this.repo.recordFailedScan(tx, file.tenantId, file.id);
      if (origin.kind === 'upload') {
        await this.audit.record(tx, file.tenantId, this.event(file, origin, 'files.file.uploaded', this.uploadSummary(file, 'pending')));
      }
    });
  }

  private uploadSummary(file: FileRow, status: 'available' | 'pending'): Record<string, unknown> {
    // Ni nom d'origine ni contenu : l'usage, le type détecté, la taille et l'empreinte suffisent à la revue.
    return { purpose: file.purpose, status, mimeType: file.mimeType, sizeBytes: Number(file.sizeBytes), sha256: file.sha256 };
  }

  private event(file: FileRow, origin: ScanOrigin, action: string, changes: Record<string, unknown>): AuditEvent {
    return {
      action,
      resourceType: 'file',
      resourceId: file.id,
      patientId: file.patientId ?? undefined,
      changes,
      ...(origin.kind === 'retry' ? { actorType: 'system' as const } : {}),
    };
  }

  /** Transaction dans le tenant du fichier, avec l'utilisateur du dépôt (aucun pour la tâche de reprise). */
  private inTx<T>(file: FileRow, origin: ScanOrigin, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.db.runAs(file.tenantId, fn, origin.kind === 'upload' ? origin.userId : undefined);
  }

  /** Suppression idempotente de l'objet d'un fichier dans `documents` ET en quarantaine (chaque suppression est tentée). */
  async deleteObjectsQuietly(fileId: string, key: string): Promise<void> {
    await this.deleteQuietly(fileId, this.documentsBucket, key);
    await this.deleteQuietly(fileId, this.quarantineBucket, key);
  }

  /**
   * Suppression d'un objet sans faire échouer l'opération : un reliquat chiffré est sans clé exploitable (clé de données
   * détruite ou jamais exposée). Journal : fichier, bucket, code d'erreur ; jamais de donnée patient ni de clé d'objet.
   */
  private async deleteQuietly(fileId: string, bucket: string, key: string): Promise<void> {
    if (!this.storage) return;
    try {
      await this.storage.delete(bucket, key);
    } catch (error) {
      this.logger.error({ fileId, bucket, errorCode: error instanceof Error ? error.name : 'unknown' }, 'Suppression d’un objet impossible');
    }
  }

  requireStorage(): ObjectStorage {
    if (!this.storage) throw new StorageUnavailableError('disabled');
    return this.storage;
  }
}
