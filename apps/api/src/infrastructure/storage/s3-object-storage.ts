import type { Readable } from 'node:stream';
import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { ObjectStorage, StoredObject } from './object-storage';
import { ObjectNotFoundError, StorageUnavailableError } from './storage-errors';

/** Délais réseau : un stockage qui ne répond pas ne doit pas bloquer une requête HTTP indéfiniment. */
const CONNECTION_TIMEOUT_MS = 3_000;
const REQUEST_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 2_000;
const MAX_ATTEMPTS = 2;
const HTTP_NOT_FOUND = 404;

export interface S3StorageSettings {
  readonly endpoint: string;
  readonly region: string;
  readonly forcePathStyle: boolean;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Bucket interrogé par la sonde `/health/ready` (HeadBucket : aucun droit d'administration requis). */
  readonly probeBucket: string;
}

interface S3ErrorShape {
  readonly name?: string;
  readonly $metadata?: { readonly httpStatusCode?: number };
}

function isNotFound(error: unknown): boolean {
  const e = error as S3ErrorShape | null;
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === HTTP_NOT_FOUND;
}

/**
 * Adaptateur S3 (docs/13 D2) : seule dépendance du code métier envers le fournisseur (SeaweedFS en développement et en CI,
 * stockage objet de la cellule en production). Les objets écrits sont déjà chiffrés (D4) : le stockage ne voit jamais
 * de contenu en clair.
 */
export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;

  constructor(private readonly settings: S3StorageSettings) {
    this.client = new S3Client({
      endpoint: settings.endpoint,
      region: settings.region,
      forcePathStyle: settings.forcePathStyle,
      credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
      maxAttempts: MAX_ATTEMPTS,
      requestHandler: { connectionTimeout: CONNECTION_TIMEOUT_MS, requestTimeout: REQUEST_TIMEOUT_MS },
    });
  }

  async put(bucket: string, key: string, body: Buffer | Readable, sizeBytes: number): Promise<StoredObject> {
    await this.send('put', () =>
      this.client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentLength: sizeBytes, ContentType: 'application/octet-stream' })),
    );
    return { bucket, key, sizeBytes };
  }

  async get(bucket: string, key: string): Promise<Readable> {
    try {
      const output = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!output.Body) throw new ObjectNotFoundError(bucket, key);
      return output.Body as Readable;
    } catch (error) {
      if (error instanceof ObjectNotFoundError) throw error;
      if (isNotFound(error)) throw new ObjectNotFoundError(bucket, key);
      throw new StorageUnavailableError('get', { cause: error });
    }
  }

  async copy(source: { readonly bucket: string; readonly key: string }, target: { readonly bucket: string; readonly key: string }): Promise<void> {
    const copySource = `${source.bucket}/${source.key.split('/').map(encodeURIComponent).join('/')}`;
    await this.send('copy', () => this.client.send(new CopyObjectCommand({ Bucket: target.bucket, Key: target.key, CopySource: copySource })));
  }

  /** Idempotent : supprimer un objet absent n'est pas une erreur (sémantique S3). */
  async delete(bucket: string, key: string): Promise<void> {
    await this.send('delete', () => this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })));
  }

  async isReachable(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.settings.probeBucket }), { abortSignal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      return true;
    } catch {
      return false;
    }
  }

  /** Développement et tests uniquement : en production, les buckets (verrouillage, cycle de vie) sont provisionnés hors de l'API. */
  async ensureBuckets(buckets: readonly string[]): Promise<void> {
    for (const bucket of buckets) {
      try {
        await this.client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch (error) {
        if (!isNotFound(error)) throw new StorageUnavailableError('ensureBuckets', { cause: error });
        await this.send('ensureBuckets', () => this.client.send(new CreateBucketCommand({ Bucket: bucket })));
      }
    }
  }

  destroy(): void {
    this.client.destroy();
  }

  private async send(operation: string, call: () => Promise<unknown>): Promise<void> {
    try {
      await call();
    } catch (error) {
      throw new StorageUnavailableError(operation, { cause: error });
    }
  }
}
