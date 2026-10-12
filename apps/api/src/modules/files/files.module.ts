import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ANTIVIRUS } from '../../infrastructure/storage/clamav-scanner';
import { OBJECT_STORAGE } from '../../infrastructure/storage/object-storage';
import { PatientDocumentsController } from './controllers/patient-documents.controller';
import { FileEnvelope } from './domain/file-envelope';
import { FilesStorageLifecycle } from './files-storage.lifecycle';
import { FILES_INFRASTRUCTURE_PROVIDERS } from './files.providers';
import { FileScanRetryJob } from './jobs/file-scan-retry.job';
import { FilesRepository } from './repositories/files.repository';
import { FileQuarantineService } from './services/file-quarantine.service';
import { PatientDocumentsService } from './services/patient-documents.service';

/**
 * Documents du patient (docs/13 §5) : stockage S3 chiffré par fichier, quarantaine et antivirus, quota du plan.
 * Le stockage et l'antivirus sont exportés pour la sonde `/health/ready`.
 */
@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [PatientDocumentsController],
  providers: [
    ...FILES_INFRASTRUCTURE_PROVIDERS,
    FileEnvelope,
    FilesRepository,
    FileQuarantineService,
    PatientDocumentsService,
    FileScanRetryJob,
    FilesStorageLifecycle,
  ],
  exports: [OBJECT_STORAGE, ANTIVIRUS],
})
export class FilesModule {}
