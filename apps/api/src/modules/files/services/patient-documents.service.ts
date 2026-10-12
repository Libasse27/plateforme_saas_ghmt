import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Injectable, Logger } from '@nestjs/common';
import { MAX_UPLOAD_BYTES, type DeleteDocumentInput, type FilePurpose, type PatientDocumentView, type PermissionKey } from '@ghmt/shared';
import { uuidv7 } from '../../notifications/domain/uuid-v7';
import { AuditService } from '../../../common/audit/audit.service';
import { scopesFor } from '../../../common/authz/authorization.service';
import { EntitlementService } from '../../../common/authz/entitlement.service';
import { RequestContext } from '../../../common/context/request-context';
import { FieldCrypto } from '../../../common/crypto/field-crypto.service';
import { Clock } from '../../../common/time/clock';
import { TenantDb, type TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { ObjectNotFoundError, StorageUnavailableError } from '../../../infrastructure/storage/storage-errors';
import { buildPatientScopeFilter } from '../../patients/domain/patient-scope';
import { inspectContent, type ContentInspection } from '../domain/content-inspection';
import { DocumentErrors } from '../domain/document-errors';
import { FileEnvelope, OBJECT_HEADER_BYTES } from '../domain/file-envelope';
import { contentDispositionAttachment, objectKeyFor, sanitizeFileName } from '../domain/file-name';
import { storageQuotaViolation } from '../domain/storage-quota';
import { toPatientDocumentView } from '../mappers/document.mapper';
import { FilesRepository, type FileRow } from '../repositories/files.repository';
import { FileQuarantineService } from './file-quarantine.service';

/** Fichier reçu du multipart (mémoire, 10 Mo au plus). */
export interface UploadedDocument {
  readonly buffer: Buffer;
  readonly originalname?: string;
  readonly size: number;
}

/** Taille maximale d'un objet stocké : contenu (10 Mo au plus) et en-tête du chiffrement. */
const MAX_SEALED_BYTES = MAX_UPLOAD_BYTES + OBJECT_HEADER_BYTES;

/** Contenu prêt à relayer : déchiffré en mémoire et intégrité vérifiée, en-têtes fixés par le serveur (docs/13 D3). */
export interface DocumentContent {
  readonly data: Buffer;
  readonly mimeType: string;
  readonly contentDisposition: string;
}

/** Lit tout le flux en mémoire ; au-delà de `maxBytes` (objet anormal), le flux est détruit et la lecture échoue. */
async function readBounded(source: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of source as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > maxBytes) {
      source.destroy();
      throw new Error('Objet stocké plus grand que la taille maximale');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

type RejectedInspection = Extract<ContentInspection, { ok: false }>;

/**
 * Documents administratifs du patient (docs/13 §5, D3 à D8). Le patient est contrôlé dans le tenant ET dans la portée
 * de la permission ; un patient ou un document d'un autre tenant répond 404, sans révéler son existence.
 */
@Injectable()
export class PatientDocumentsService {
  private readonly logger = new Logger(PatientDocumentsService.name);

  constructor(
    private readonly db: TenantDb,
    private readonly repo: FilesRepository,
    private readonly crypto: FieldCrypto,
    private readonly envelope: FileEnvelope,
    private readonly quarantine: FileQuarantineService,
    private readonly entitlements: EntitlementService,
    private readonly audit: AuditService,
    private readonly context: RequestContext,
    private readonly clock: Clock,
  ) {}

  async upload(patientId: string, purpose: FilePurpose, file: UploadedDocument | undefined): Promise<PatientDocumentView> {
    const { tenantId, userId } = this.context.requirePrincipal();
    const storage = this.storageOrUnavailable();
    if (!file || file.size === 0 || file.buffer.length === 0) throw DocumentErrors.fileRequired();
    if (file.buffer.length > MAX_UPLOAD_BYTES) throw DocumentErrors.fileTooLarge();
    // Le patient est contrôlé AVANT l'antivirus et l'enregistrement d'un rejet : un identifiant inventé ne consomme pas clamd.
    await this.db.run((tx) => this.requirePatient(tx, tenantId, patientId, 'patients:identity_doc:create', DocumentErrors.patientNotFound));
    const inspection = await inspectContent(file.buffer);
    const content = inspection.ok ? inspection.content : file.buffer;
    const { data, sealedObject } = this.prepareRecord(patientId, purpose, file.originalname, content, inspection.mimeType);
    if (!inspection.ok) return this.recordRejection(patientId, data, inspection, file.buffer);

    // La ligne `pending` est créée avant l'écriture : elle compte dans le quota (dépôts concurrents) et sert à la reprise.
    const row = await this.db.run(async (tx) => {
      await this.requirePatient(tx, tenantId, patientId, 'patients:identity_doc:create', DocumentErrors.patientNotFound);
      await this.assertStorageQuota(tx, tenantId, content.length);
      return this.repo.create(tx, { ...data, status: 'pending' });
    });
    try {
      await storage.put(this.quarantine.quarantineBucket, row.objectKey, sealedObject, sealedObject.length);
    } catch (error) {
      await this.db.run((tx) => this.repo.discardPending(tx, tenantId, row.id));
      throw this.translateStorageError(error);
    }
    const outcome = await this.quarantine.scanAndSettle(row, content, { kind: 'upload', userId });
    if (outcome.status === 'rejected') throw DocumentErrors.infected();
    return this.db.run(async (tx) => {
      const current = await this.repo.findForPatient(tx, tenantId, patientId, row.id, ['available', 'pending']);
      if (!current) throw DocumentErrors.documentNotFound();
      return toPatientDocumentView(current, this.crypto, await this.repo.userNames(tx, tenantId, [current.createdBy]));
    });
  }

  list(patientId: string): Promise<{ items: PatientDocumentView[] }> {
    const { tenantId } = this.context.requirePrincipal();
    return this.db.run(async (tx) => {
      await this.requirePatient(tx, tenantId, patientId, 'patients:identity_doc:read', DocumentErrors.patientNotFound);
      const rows = await this.repo.listForPatient(tx, tenantId, patientId);
      const names = await this.repo.userNames(tx, tenantId, rows.map((row) => row.createdBy));
      await this.audit.record(tx, tenantId, {
        action: 'files.file.listed',
        resourceType: 'file',
        patientId,
        changes: { fileIds: rows.map((row) => row.id) },
      });
      return { items: rows.map((row) => toPatientDocumentView(row, this.crypto, names)) };
    });
  }

  /** Téléchargement : seul un fichier `available` est servi ; la lecture est auditée avant l'envoi (`files.file.downloaded`). */
  async openContent(patientId: string, documentId: string): Promise<DocumentContent> {
    const { tenantId } = this.context.requirePrincipal();
    const storage = this.storageOrUnavailable();
    const row = await this.db.run(async (tx) => {
      await this.requirePatient(tx, tenantId, patientId, 'patients:identity_doc:read', DocumentErrors.documentNotFound);
      const file = await this.repo.findForPatient(tx, tenantId, patientId, documentId, ['available']);
      if (!file) throw DocumentErrors.documentNotFound();
      await this.audit.record(tx, tenantId, { action: 'files.file.downloaded', resourceType: 'file', resourceId: file.id, patientId });
      return file;
    });
    let sealed: Buffer;
    try {
      sealed = await readBounded(await storage.get(this.quarantine.documentsBucket, row.objectKey), MAX_SEALED_BYTES);
    } catch (error) {
      throw this.translateStorageError(error);
    }
    return {
      data: this.decryptOrFail(tenantId, row, sealed),
      mimeType: row.mimeType,
      contentDisposition: contentDispositionAttachment(this.crypto.decrypt(tenantId, row.originalName)),
    };
  }

  /**
   * Suppression avec motif : la ligne passe à `deleted` (clé de données détruite, effacement cryptographique) avec son audit
   * dans la transaction ; les objets (documents et quarantaine) sont supprimés APRÈS le commit, de façon idempotente. Un échec
   * de suppression est journalisé et ne fait pas échouer la requête : l'objet restant est indéchiffrable.
   */
  async remove(patientId: string, documentId: string, input: DeleteDocumentInput): Promise<void> {
    const { tenantId } = this.context.requirePrincipal();
    this.storageOrUnavailable();
    const file = await this.db.run(async (tx) => {
      await this.requirePatient(tx, tenantId, patientId, 'patients:identity_doc:delete', DocumentErrors.documentNotFound);
      const file = await this.repo.findForPatient(tx, tenantId, patientId, documentId, ['available', 'pending']);
      if (!file || !(await this.repo.markDeleted(tx, tenantId, file.id, this.clock.now()))) throw DocumentErrors.documentNotFound();
      await this.audit.record(tx, tenantId, {
        action: 'files.file.deleted',
        resourceType: 'file',
        resourceId: file.id,
        patientId,
        changes: { reason: input.reason, previousStatus: file.status },
      });
      return file;
    });
    await this.quarantine.deleteObjectsQuietly(file.id, file.objectKey);
  }

  /** Ligne du fichier (sans statut) et objet chiffré : identifiant v7, clé d'objet sans nom, nom d'origine chiffré, empreinte. */
  private prepareRecord(patientId: string, purpose: FilePurpose, originalName: string | undefined, content: Buffer, mimeType: string) {
    const { tenantId, userId } = this.context.requirePrincipal();
    const id = uuidv7();
    const now = this.clock.now();
    const sealed = this.envelope.seal(tenantId, id, content);
    const data = {
      id,
      tenantId,
      purpose,
      patientId,
      objectKey: objectKeyFor(tenantId, id, now),
      wrappedKey: sealed.wrappedKey,
      originalName: this.crypto.encrypt(tenantId, sanitizeFileName(originalName)),
      mimeType,
      sizeBytes: BigInt(content.length),
      sha256: createHash('sha256').update(content).digest('hex'),
      createdBy: userId,
      createdAt: now,
    };
    return { data, sealedObject: sealed.object };
  }

  /**
   * Type refusé ou PDF actif : ligne `rejected` sans objet stocké, et audit, validés AVANT de répondre en erreur
   * (une levée dans la transaction annulerait la trace).
   */
  private async recordRejection(
    patientId: string,
    data: Omit<Parameters<FilesRepository['create']>[1], 'status'>,
    inspection: RejectedInspection,
    rawContent: Buffer,
  ): Promise<never> {
    const { tenantId } = this.context.requirePrincipal();
    // Un fichier refusé pour son type est aussi analysé : un virus est signalé comme tel (message antivirus), docs/13 D5.
    const signature = await this.quarantine.detectInfection(rawContent);
    const reason = signature ? 'infected' : inspection.reason;
    await this.db.run(async (tx) => {
      await this.requirePatient(tx, tenantId, patientId, 'patients:identity_doc:create', DocumentErrors.patientNotFound);
      const row = await this.repo.create(tx, { ...data, status: 'rejected', rejectReason: reason });
      await this.audit.record(tx, tenantId, {
        action: 'files.file.rejected',
        resourceType: 'file',
        resourceId: row.id,
        patientId,
        changes: {
          reason,
          ...(signature ? { signature } : {}),
          purpose: data.purpose,
          mimeType: inspection.mimeType,
          sizeBytes: Number(data.sizeBytes),
        },
      });
    });
    if (reason === 'infected') throw DocumentErrors.infected();
    throw reason === 'active_content' ? DocumentErrors.activeContent() : DocumentErrors.typeNotAllowed();
  }

  private async assertStorageQuota(tx: TenantTx, tenantId: string, addedBytes: number): Promise<void> {
    await this.repo.lockStorageQuota(tx);
    const current = await this.entitlements.getInTx(tx);
    if (!current) return;
    const violation = storageQuotaViolation(current.entitlements.limits.storageGb, await this.repo.usedBytes(tx, tenantId), addedBytes);
    if (violation) throw DocumentErrors.storageQuotaReached(violation);
  }

  /** Patient du tenant, non supprimé, dans la portée de la permission (A6) ; sinon 404 (code selon la route). */
  private async requirePatient(tx: TenantTx, tenantId: string, patientId: string, permission: PermissionKey, notFound: () => Error): Promise<void> {
    const scope = scopesFor(permission, this.context.grants);
    const departmentSites = scope.allTenant ? [] : await this.repo.siteIdsOfDepartments(tx, tenantId, scope.departmentIds);
    if (!(await this.repo.patientExists(tx, tenantId, patientId, buildPatientScopeFilter(scope, departmentSites)))) throw notFound();
  }

  /** Déchiffrement entier en mémoire : le tag GCM est vérifié avant d'envoyer le moindre octet ; objet altéré ⇒ 500 sans contenu. */
  private decryptOrFail(tenantId: string, row: FileRow, sealed: Buffer): Buffer {
    try {
      if (!row.wrappedKey) throw new Error('Clé de données absente');
      return this.envelope.open(tenantId, row.id, row.wrappedKey, sealed);
    } catch (error) {
      this.logger.error({ fileId: row.id, errorCode: error instanceof Error ? error.name : 'unknown' }, 'Document illisible : intégrité non vérifiée');
      throw DocumentErrors.documentUnreadable();
    }
  }

  private storageOrUnavailable() {
    try {
      return this.quarantine.requireStorage();
    } catch {
      throw DocumentErrors.storageUnavailable();
    }
  }

  private translateStorageError(error: unknown): Error {
    if (error instanceof StorageUnavailableError) return DocumentErrors.storageUnavailable();
    if (error instanceof ObjectNotFoundError) {
      // Ligne `available` sans objet : incohérence d'exploitation, journalisée sans donnée patient.
      this.logger.error({ bucket: error.bucket }, 'Objet de document absent du stockage');
      return DocumentErrors.documentNotFound();
    }
    return error instanceof Error ? error : new Error('Erreur de stockage inattendue');
  }
}
