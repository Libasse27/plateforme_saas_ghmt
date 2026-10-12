import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENV, loadEnv } from '../../src/infrastructure/config/env';
import { ANTIVIRUS, ClamdScanner, type Antivirus } from '../../src/infrastructure/storage/clamav-scanner';
import { FileScanRetryJob } from '../../src/modules/files/jobs/file-scan-retry.job';
import { createTenantFixture, createUserWithRole, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { createPatientRow, download, fileRow, sha256, upload } from './documents-support';
import { testFilesEnv, testStorageSettings } from './storage-env';
import { S3ObjectStorage } from '../../src/infrastructure/storage/s3-object-storage';
import { eicar, pdf } from './samples';

/** Port local sans service : un clamd coupé (connexion refusée). */
const CLOSED_PORT = 9;
const realHost = process.env['CLAMAV_TEST_HOST'];
const realPort = Number(process.env['CLAMAV_TEST_PORT'] ?? 3310);

/** Antivirus réel qu'un test peut « couper » (clamd injoignable) puis rétablir. */
class SwitchableClamd implements Antivirus {
  readonly enabled = true;
  stopped = false;
  private readonly up = new ClamdScanner({ host: realHost ?? '', port: realPort });
  private readonly down = new ClamdScanner({ host: '127.0.0.1', port: CLOSED_PORT });

  scan(content: Buffer) {
    return (this.stopped ? this.down : this.up).scan(content);
  }

  isReachable() {
    return (this.stopped ? this.down : this.up).isReachable();
  }
}

// docs/13 §11.2 étape 4, contre un vrai clamd : `CLAMAV_TEST_HOST=127.0.0.1` avec le service `clamav` du compose démarré.
describe.skipIf(!realHost)('documents : antivirus ClamAV réel', () => {
  let app: INestApplication;
  let clamd: SwitchableClamd;
  let clerk: UserFixture;
  let tenantId: string;
  let patientId: string;

  beforeAll(async () => {
    const settings = testStorageSettings();
    await new S3ObjectStorage({ ...settings, probeBucket: settings.documentsBucket }).ensureBuckets([settings.quarantineBucket, settings.documentsBucket]);
    clamd = new SwitchableClamd();
    app = await createTestApp({}, {
      providerOverrides: [
        { token: ENV, useValue: loadEnv({ ...process.env, ...testFilesEnv(), CLAMAV_HOST: realHost }) },
        { token: ANTIVIRUS, useValue: clamd },
      ],
    });
    const tenant = await createTenantFixture(app, { prefix: 'doc-clam' });
    tenantId = tenant.tenantId;
    clerk = await createUserWithRole(app, tenant, 'receptionist');
    patientId = await createPatientRow(app, tenant);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('rejette le fichier EICAR (422 infected) et accepte un fichier sain', async () => {
    // EICAR n'est pas un PDF : l'antivirus est consulté avant le refus de type, le motif affiché est l'infection.
    const infected = await upload(app, clerk, patientId, eicar(), 'eicar.pdf').expect(422);
    const clean = await upload(app, clerk, patientId, pdf(), 'sain.pdf').expect(201);

    expect(infected.body.code).toBe('infected');
    expect(clean.body.data.status).toBe('available');
  });

  it('clamd coupé : dépôt « pending », puis disponible après reprise par la tâche', async () => {
    clamd.stopped = true;
    const content = pdf();
    const created = await upload(app, clerk, patientId, content, 'coupure.pdf').expect(201);
    clamd.stopped = false;

    const report = await app.get(FileScanRetryJob).runOnce(new Date(Date.now() + 3 * 60_000), { tenantIds: [tenantId] });

    expect(created.body.data.status).toBe('pending');
    expect(report.available).toBe(1);
    expect((await fileRow(app, tenantId, created.body.data.id))!.status).toBe('available');
    expect(sha256((await download(app, clerk, patientId, created.body.data.id).expect(200)).body as Buffer)).toBe(sha256(content));
  });
});
