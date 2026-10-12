import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../infrastructure/config/env';
import { ClamdScanner, DisabledAntivirus } from '../../infrastructure/storage/clamav-scanner';
import type { ObjectStorage } from '../../infrastructure/storage/object-storage';
import { S3ObjectStorage } from '../../infrastructure/storage/s3-object-storage';
import { FilesStorageLifecycle } from './files-storage.lifecycle';
import { antivirusFor, objectStorageFor } from './files.providers';

const FILES_ENV = {
  FILES_ENABLED: true,
  NODE_ENV: 'development',
  S3_ENDPOINT: 'http://localhost:8333',
  S3_REGION: 'us-east-1',
  S3_FORCE_PATH_STYLE: true,
  S3_ACCESS_KEY_ID: 'ghmt-dev',
  S3_SECRET_ACCESS_KEY: 'secret-de-test',
  S3_BUCKET_QUARANTINE: 'q-bucket',
  S3_BUCKET_DOCUMENTS: 'd-bucket',
  CLAMAV_HOST: 'clamav',
  CLAMAV_PORT: 3310,
} as unknown as Env;

describe('fournisseurs des documents', () => {
  it('crée l’adaptateur S3 seulement quand les documents sont activés et configurés', () => {
    expect(objectStorageFor(FILES_ENV)).toBeInstanceOf(S3ObjectStorage);
    expect(objectStorageFor({ ...FILES_ENV, FILES_ENABLED: false })).toBeNull();
    expect(objectStorageFor({ ...FILES_ENV, S3_ENDPOINT: undefined })).toBeNull();
  });

  it('utilise clamd si CLAMAV_HOST est fourni, sinon désactive l’analyse', () => {
    expect(antivirusFor(FILES_ENV)).toBeInstanceOf(ClamdScanner);
    expect(antivirusFor({ ...FILES_ENV, CLAMAV_HOST: undefined })).toBeInstanceOf(DisabledAntivirus);
    expect(antivirusFor({ ...FILES_ENV, FILES_ENABLED: false })).toBeInstanceOf(DisabledAntivirus);
  });
});

describe('FilesStorageLifecycle', () => {
  const s3 = (): S3ObjectStorage => {
    const storage = objectStorageFor(FILES_ENV)!;
    vi.spyOn(storage, 'ensureBuckets').mockResolvedValue();
    vi.spyOn(storage, 'destroy');
    return storage;
  };

  it('crée les buckets en développement, et libère le client à l’arrêt', async () => {
    const storage = s3();
    const lifecycle = new FilesStorageLifecycle(FILES_ENV, storage, new DisabledAntivirus());

    await lifecycle.onModuleInit();
    lifecycle.onApplicationShutdown();

    expect(storage.ensureBuckets).toHaveBeenCalledWith(['q-bucket', 'd-bucket']);
    expect(storage.destroy).toHaveBeenCalled();
  });

  it('ne crée aucun bucket hors développement ni documents désactivés', async () => {
    const storage = s3();

    await new FilesStorageLifecycle({ ...FILES_ENV, NODE_ENV: 'production' } as Env, storage, antivirusFor(FILES_ENV)).onModuleInit();
    await new FilesStorageLifecycle({ ...FILES_ENV, FILES_ENABLED: false }, storage, new DisabledAntivirus()).onModuleInit();

    expect(storage.ensureBuckets).not.toHaveBeenCalled();
  });

  it('n’échoue pas au démarrage si le stockage de développement est injoignable', async () => {
    const storage = s3();
    vi.mocked(storage.ensureBuckets).mockRejectedValue(new Error('coupé'));

    await expect(new FilesStorageLifecycle(FILES_ENV, storage, new DisabledAntivirus()).onModuleInit()).resolves.toBeUndefined();
  });

  it('tolère un stockage absent ou d’un autre type', async () => {
    const other = { isReachable: () => Promise.resolve(true) } as unknown as ObjectStorage;

    await expect(new FilesStorageLifecycle(FILES_ENV, null, new DisabledAntivirus()).onModuleInit()).resolves.toBeUndefined();
    expect(() => new FilesStorageLifecycle(FILES_ENV, other, new DisabledAntivirus()).onApplicationShutdown()).not.toThrow();
  });
});
