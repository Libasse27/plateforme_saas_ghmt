import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ENV, loadEnv } from '../../src/infrastructure/config/env';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { ANTIVIRUS, AntivirusUnavailableError, type Antivirus, type ScanVerdict } from '../../src/infrastructure/storage/clamav-scanner';
import { OBJECT_STORAGE, type ObjectStorage, type StoredObject } from '../../src/infrastructure/storage/object-storage';
import { S3ObjectStorage } from '../../src/infrastructure/storage/s3-object-storage';
import { StorageUnavailableError } from '../../src/infrastructure/storage/storage-errors';
import { createTestApp } from '../helpers/test-app';
import type { TenantFixture, UserFixture } from '../helpers/fixtures';
import { testFilesEnv, testStorageSettings } from './storage-env';

/** Antivirus piloté par le test : sain, infecté, ou indisponible (clamd coupé). */
export class FakeAntivirus implements Antivirus {
  readonly enabled = true;
  mode: 'clean' | 'infected' | 'down' = 'clean';
  scans = 0;

  scan(): Promise<ScanVerdict> {
    this.scans += 1;
    if (this.mode === 'down') return Promise.reject(new AntivirusUnavailableError('clamd coupé (test)'));
    return Promise.resolve(this.mode === 'infected' ? { status: 'infected', signature: 'Eicar-Test-Signature' } : { status: 'clean' });
  }

  isReachable(): Promise<boolean> {
    return Promise.resolve(this.mode !== 'down');
  }
}

/** Stockage S3 réel (SeaweedFS de test) qu'un test peut rendre injoignable. */
export class SwitchableStorage implements ObjectStorage {
  offline = false;

  constructor(readonly real: S3ObjectStorage) {}

  put(bucket: string, key: string, body: Buffer | Readable, sizeBytes: number): Promise<StoredObject> {
    return this.guard('put', () => this.real.put(bucket, key, body, sizeBytes));
  }

  get(bucket: string, key: string): Promise<Readable> {
    return this.guard('get', () => this.real.get(bucket, key));
  }

  copy(source: { bucket: string; key: string }, target: { bucket: string; key: string }): Promise<void> {
    return this.guard('copy', () => this.real.copy(source, target));
  }

  delete(bucket: string, key: string): Promise<void> {
    return this.guard('delete', () => this.real.delete(bucket, key));
  }

  isReachable(): Promise<boolean> {
    return this.offline ? Promise.resolve(false) : this.real.isReachable();
  }

  private guard<T>(operation: string, call: () => Promise<T>): Promise<T> {
    return this.offline ? Promise.reject(new StorageUnavailableError(operation)) : call();
  }
}

export interface DocumentsTestApp {
  readonly app: INestApplication;
  readonly antivirus: FakeAntivirus;
  readonly storage: SwitchableStorage;
  readonly buckets: { readonly quarantine: string; readonly documents: string };
}

/** Application de test avec les documents activés (buckets propres à l'équipe DOC), antivirus simulé et stockage commutable. */
export async function createDocumentsTestApp(): Promise<DocumentsTestApp> {
  const settings = testStorageSettings();
  const real = new S3ObjectStorage({ ...settings, probeBucket: settings.documentsBucket });
  await real.ensureBuckets([settings.quarantineBucket, settings.documentsBucket]);
  const antivirus = new FakeAntivirus();
  const storage = new SwitchableStorage(real);
  const env = loadEnv({ ...process.env, ...testFilesEnv() });
  const app = await createTestApp({}, {
    providerOverrides: [
      { token: ENV, useValue: env },
      { token: ANTIVIRUS, useValue: antivirus },
      { token: OBJECT_STORAGE, useValue: storage },
    ],
  });
  return { app, antivirus, storage, buckets: { quarantine: settings.quarantineBucket, documents: settings.documentsBucket } };
}

export const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

export const auth = (user: UserFixture | { token: string }) => ({ Authorization: `Bearer ${user.token}` });

/** Dépôt multipart (champ `file`, champ `purpose`). */
export function upload(app: INestApplication, user: { token: string }, patientId: string, content: Buffer, fileName: string, purpose = 'identity') {
  return request(app.getHttpServer())
    .post(`/api/v1/patients/${patientId}/documents`)
    .set(auth(user))
    .field('purpose', purpose)
    .attach('file', content, { filename: fileName, contentType: 'application/pdf' });
}

/** Téléchargement : corps binaire reconstitué en Buffer, ou problème JSON décodé en cas d'erreur. */
export function download(app: INestApplication, user: { token: string }, patientId: string, documentId: string) {
  return request(app.getHttpServer())
    .get(`/api/v1/patients/${patientId}/documents/${documentId}/content`)
    .set(auth(user))
    .buffer(true)
    .parse((res, callback) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        const isJson = String(res.headers['content-type'] ?? '').includes('json');
        callback(null, isJson ? JSON.parse(body.toString('utf8')) : body);
      });
    });
}

/** Patient minimal créé directement en base (les suites des documents ne testent pas le module patients). */
export async function createPatientRow(app: INestApplication, tenant: TenantFixture, primarySiteId: string | null = null): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 10).toUpperCase();
  return app.get(TenantDb).runAs(tenant.tenantId, async (tx) => {
    const row = await tx.patient.create({
      data: {
        tenantId: tenant.tenantId,
        ipp: `D${suffix}`,
        lastName: 'Ndiaye',
        firstName: 'Fatou',
        searchName: 'ndiaye fatou',
        primarySiteId,
        createdBy: tenant.adminUserId,
        updatedBy: tenant.adminUserId,
      },
      select: { id: true },
    });
    return row.id;
  });
}

export function fileRow(app: INestApplication, tenantId: string, id: string) {
  return app.get(TenantDb).runAs(tenantId, (tx) => tx.storedFile.findUnique({ where: { tenantId_id: { tenantId, id } } }));
}

export function auditOf(app: INestApplication, tenantId: string, action: string, resourceId?: string) {
  return app
    .get(TenantDb)
    .runAs(tenantId, (tx) => tx.auditLog.findMany({ where: { action, ...(resourceId ? { resourceId } : {}) }, orderBy: { chainSeq: 'asc' } }));
}
