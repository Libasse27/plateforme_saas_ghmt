import type { Provider } from '@nestjs/common';
import { ENV, type Env } from '../../infrastructure/config/env';
import { ANTIVIRUS, ClamdScanner, DisabledAntivirus, type Antivirus } from '../../infrastructure/storage/clamav-scanner';
import { OBJECT_STORAGE } from '../../infrastructure/storage/object-storage';
import { S3ObjectStorage } from '../../infrastructure/storage/s3-object-storage';

/** Stockage S3 si les documents sont activés (`FILES_ENABLED`), sinon `null` : les routes répondent 503 `storage_unavailable`. */
export function objectStorageFor(env: Env): S3ObjectStorage | null {
  if (!env.FILES_ENABLED || !env.S3_ENDPOINT || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) return null;
  return new S3ObjectStorage({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    probeBucket: env.S3_BUCKET_DOCUMENTS,
  });
}

/** clamd si `CLAMAV_HOST` est fourni avec les documents activés ; sinon analyse ignorée (refusé au démarrage en production). */
export function antivirusFor(env: Env): Antivirus {
  if (!env.FILES_ENABLED || !env.CLAMAV_HOST) return new DisabledAntivirus();
  return new ClamdScanner({ host: env.CLAMAV_HOST, port: env.CLAMAV_PORT });
}

export const FILES_INFRASTRUCTURE_PROVIDERS: Provider[] = [
  { provide: OBJECT_STORAGE, inject: [ENV], useFactory: objectStorageFor },
  { provide: ANTIVIRUS, inject: [ENV], useFactory: antivirusFor },
];
