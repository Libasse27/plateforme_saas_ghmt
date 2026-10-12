import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { beforeAll, describe, expect, it } from 'vitest';
import { testStorageSettings } from '../../../test/files/storage-env';
import { ObjectNotFoundError, StorageUnavailableError } from './storage-errors';
import { S3ObjectStorage } from './s3-object-storage';

// Test d'intégration contre le SeaweedFS de développement (docs/13 §11.2, étape 1).
describe('S3ObjectStorage (intégration SeaweedFS)', () => {
  const settings = testStorageSettings();
  const storage = new S3ObjectStorage({ ...settings, probeBucket: settings.documentsBucket });
  const key = (): string => `t/${randomUUID()}/files/2026/10/${randomUUID()}`;

  beforeAll(async () => {
    await storage.ensureBuckets([settings.quarantineBucket, settings.documentsBucket]);
  });

  it('écrit un tampon puis le relit en flux, octet pour octet', async () => {
    const objectKey = key();
    const content = randomBytes(64 * 1024);

    const stored = await storage.put(settings.quarantineBucket, objectKey, content, content.length);
    const stream = await storage.get(settings.quarantineBucket, objectKey);

    expect(stored).toEqual({ bucket: settings.quarantineBucket, key: objectKey, sizeBytes: content.length });
    expect(stream).toBeInstanceOf(Readable);
    expect((await buffer(stream)).equals(content)).toBe(true);
  });

  it('accepte un flux en entrée', async () => {
    const objectKey = key();
    const content = randomBytes(1024);

    await storage.put(settings.quarantineBucket, objectKey, Readable.from([content.subarray(0, 512), content.subarray(512)]), content.length);

    expect((await buffer(await storage.get(settings.quarantineBucket, objectKey))).equals(content)).toBe(true);
  });

  it('copie un objet de la quarantaine vers les documents, puis le supprime de la source', async () => {
    const objectKey = key();
    const content = randomBytes(2048);
    await storage.put(settings.quarantineBucket, objectKey, content, content.length);

    await storage.copy({ bucket: settings.quarantineBucket, key: objectKey }, { bucket: settings.documentsBucket, key: objectKey });
    await storage.delete(settings.quarantineBucket, objectKey);

    expect((await buffer(await storage.get(settings.documentsBucket, objectKey))).equals(content)).toBe(true);
    await expect(storage.get(settings.quarantineBucket, objectKey)).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it('signale un objet absent par ObjectNotFoundError, et tolère la suppression d’un objet absent', async () => {
    await expect(storage.get(settings.documentsBucket, key())).rejects.toBeInstanceOf(ObjectNotFoundError);
    await expect(storage.delete(settings.documentsBucket, key())).resolves.toBeUndefined();
  });

  it('crée les buckets manquants de façon idempotente', async () => {
    await expect(storage.ensureBuckets([settings.documentsBucket])).resolves.toBeUndefined();
  });

  it('répond joignable quand le bucket de sonde existe', async () => {
    expect(await storage.isReachable()).toBe(true);
  });

  it('répond injoignable, et lève StorageUnavailableError, quand le service ne répond pas', async () => {
    const offline = new S3ObjectStorage({ ...settings, endpoint: 'http://127.0.0.1:9', probeBucket: settings.documentsBucket });

    expect(await offline.isReachable()).toBe(false);
    await expect(offline.put(settings.quarantineBucket, key(), Buffer.from('x'), 1)).rejects.toBeInstanceOf(StorageUnavailableError);
    await expect(offline.get(settings.quarantineBucket, key())).rejects.toBeInstanceOf(StorageUnavailableError);
    await expect(offline.copy({ bucket: settings.quarantineBucket, key: key() }, { bucket: settings.documentsBucket, key: key() })).rejects.toBeInstanceOf(
      StorageUnavailableError,
    );
    await expect(offline.delete(settings.quarantineBucket, key())).rejects.toBeInstanceOf(StorageUnavailableError);
  });
});
