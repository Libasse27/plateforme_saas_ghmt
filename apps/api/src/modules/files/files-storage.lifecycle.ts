import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { ENV, type Env } from '../../infrastructure/config/env';
import { ANTIVIRUS, type Antivirus } from '../../infrastructure/storage/clamav-scanner';
import { OBJECT_STORAGE, type ObjectStorage } from '../../infrastructure/storage/object-storage';
import { S3ObjectStorage } from '../../infrastructure/storage/s3-object-storage';

/**
 * Démarrage des documents : avertissement si l'antivirus est absent (hors production : analyse ignorée), création des
 * buckets en développement (en production, ils sont provisionnés avec verrouillage et cycle de vie, hors de l'API).
 */
@Injectable()
export class FilesStorageLifecycle implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(FilesStorageLifecycle.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage | null,
    @Inject(ANTIVIRUS) private readonly antivirus: Antivirus,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.env.FILES_ENABLED) return;
    if (!this.antivirus.enabled) {
      this.logger.warn('CLAMAV_HOST absent : les documents déposés ne sont PAS analysés par l’antivirus (interdit en production).');
    }
    if (this.env.NODE_ENV === 'development' && this.storage instanceof S3ObjectStorage) {
      try {
        await this.storage.ensureBuckets([this.env.S3_BUCKET_QUARANTINE, this.env.S3_BUCKET_DOCUMENTS]);
      } catch (error) {
        this.logger.error({ errorCode: error instanceof Error ? error.name : 'unknown' }, 'Création des buckets de développement impossible');
      }
    }
  }

  onApplicationShutdown(): void {
    if (this.storage instanceof S3ObjectStorage) this.storage.destroy();
  }
}
