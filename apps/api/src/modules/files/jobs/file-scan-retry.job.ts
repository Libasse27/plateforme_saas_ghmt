import { buffer } from 'node:stream/consumers';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Clock } from '../../../common/time/clock';
import { ENV, type Env } from '../../../infrastructure/config/env';
import { PlatformDb } from '../../../infrastructure/prisma/platform-db.service';
import { TenantDb } from '../../../infrastructure/prisma/tenant-db.service';
import { ObjectNotFoundError } from '../../../infrastructure/storage/storage-errors';
import { FileEnvelope } from '../domain/file-envelope';
import { FilesRepository, type FileRow } from '../repositories/files.repository';
import { FileQuarantineService, type ScanOutcome } from '../services/file-quarantine.service';

/** Durée de reprise (docs/13 D5) : au-delà, le fichier est rejeté (`scan_unavailable`). */
export const SCAN_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Un dépôt de moins de 2 minutes peut être en cours (objet pas encore écrit) : la tâche ne le reprend pas. */
export const SCAN_RETRY_GRACE_MS = 2 * 60 * 1000;
/** Fichiers repris par établissement et par passage (borne la durée d'un passage). */
const BATCH_SIZE = 50;

export interface ScanRetryReport {
  readonly examined: number;
  readonly available: number;
  readonly rejected: number;
  readonly stillPending: number;
  /** Vrai si le passage s'est arrêté faute d'antivirus (inutile d'insister sur les fichiers suivants). */
  readonly antivirusUnavailable: boolean;
  readonly errors: number;
}

interface MutableReport {
  examined: number;
  available: number;
  rejected: number;
  stillPending: number;
  antivirusUnavailable: boolean;
  errors: number;
}

/**
 * Reprise de l'analyse antivirus (docs/13 D5), toutes les 5 minutes : fichiers `pending` (clamd indisponible au dépôt),
 * déchiffrés depuis la quarantaine et analysés de nouveau ; après 24 h, rejet `scan_unavailable`.
 */
@Injectable()
export class FileScanRetryJob {
  private readonly logger = new Logger(FileScanRetryJob.name);
  private running = false;

  constructor(
    private readonly platformDb: PlatformDb,
    private readonly db: TenantDb,
    private readonly repo: FilesRepository,
    private readonly envelope: FileEnvelope,
    private readonly quarantine: FileQuarantineService,
    private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Cron('*/5 * * * *')
  async scheduledRun(): Promise<void> {
    if (!this.env.FILES_ENABLED || this.env.NODE_ENV === 'test' || this.running) return;
    this.running = true;
    try {
      const report = await this.runOnce(this.clock.now());
      if (report.examined > 0) this.logger.log({ ...report }, 'Reprise de l’analyse antivirus');
    } catch (error: unknown) {
      this.logger.error({ errorCode: error instanceof Error ? error.name : 'unknown' }, 'Échec de la reprise de l’analyse antivirus');
    } finally {
      this.running = false;
    }
  }

  /** Passage déterministe (horloge en paramètre) ; un établissement en erreur n'interrompt pas les autres. */
  async runOnce(now: Date, options: { readonly tenantIds?: readonly string[] } = {}): Promise<ScanRetryReport> {
    const report: MutableReport = { examined: 0, available: 0, rejected: 0, stillPending: 0, antivirusUnavailable: false, errors: 0 };
    for (const tenantId of options.tenantIds ?? (await this.activeTenants())) {
      try {
        await this.retryTenant(tenantId, now, report);
      } catch (error: unknown) {
        report.errors += 1;
        this.logger.error({ tenantId, errorCode: error instanceof Error ? error.name : 'unknown' }, 'Reprise impossible pour un établissement');
      }
    }
    return report;
  }

  private async retryTenant(tenantId: string, now: Date, report: MutableReport): Promise<void> {
    const createdBefore = new Date(now.getTime() - SCAN_RETRY_GRACE_MS);
    const files = await this.db.runAs(tenantId, (tx) => this.repo.pendingCreatedBefore(tx, tenantId, createdBefore, BATCH_SIZE));
    for (const file of files) {
      report.examined += 1;
      if (now.getTime() - file.createdAt.getTime() > SCAN_RETRY_WINDOW_MS) {
        await this.count(report, this.quarantine.reject(file, 'scan_unavailable', { kind: 'retry' }));
        continue;
      }
      if (report.antivirusUnavailable) {
        report.stillPending += 1;
        continue;
      }
      const plaintext = await this.readQuarantined(file);
      if (!plaintext) {
        // Objet jamais écrit (dépôt interrompu) ou illisible (corrompu, clé absente) : aucune analyse possible, on passe au suivant.
        await this.count(report, this.quarantine.reject(file, 'scan_unavailable', { kind: 'retry' }));
        continue;
      }
      await this.count(report, this.quarantine.scanAndSettle(file, plaintext, { kind: 'retry' }));
    }
  }

  private async count(report: MutableReport, pending: Promise<ScanOutcome>): Promise<void> {
    const outcome = await pending;
    if (outcome.status === 'available') report.available += 1;
    else if (outcome.status === 'rejected') report.rejected += 1;
    else if (outcome.status === 'pending') {
      report.stillPending += 1;
      if (outcome.cause === 'antivirus_unavailable') report.antivirusUnavailable = true;
    }
  }

  /**
   * Contenu en clair d'un fichier en quarantaine ; `undefined` si l'objet est absent ou illisible (déchiffrement impossible :
   * fichier à rejeter, journalisé sans donnée patient). Une panne du stockage reste propagée : ce n'est pas la faute du fichier.
   */
  private async readQuarantined(file: FileRow): Promise<Buffer | undefined> {
    let sealed: Buffer;
    try {
      sealed = await buffer(await this.quarantine.requireStorage().get(this.quarantine.quarantineBucket, file.objectKey));
    } catch (error) {
      if (error instanceof ObjectNotFoundError) return undefined;
      throw error;
    }
    try {
      if (!file.wrappedKey) throw new Error('Clé de données absente');
      return this.envelope.open(file.tenantId, file.id, file.wrappedKey, sealed);
    } catch (error) {
      this.logger.error({ fileId: file.id, errorCode: error instanceof Error ? error.name : 'unknown' }, 'Objet en quarantaine illisible : fichier rejeté');
      return undefined;
    }
  }

  private async activeTenants(): Promise<string[]> {
    const tenants = await this.platformDb.run((tx) => tx.tenant.findMany({ where: { deletedAt: null }, select: { id: true }, orderBy: { id: 'asc' } }));
    return tenants.map((tenant) => tenant.id);
  }
}
