import { buffer } from 'node:stream/consumers';
import { Logger, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { ObjectNotFoundError } from '../../src/infrastructure/storage/storage-errors';
import { FileScanRetryJob } from '../../src/modules/files/jobs/file-scan-retry.job';
import { createTenantFixture, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { auditOf, auth, createDocumentsTestApp, createPatientRow, download, fileRow, upload, type FakeAntivirus, type SwitchableStorage } from './documents-support';
import { pdf, windowsExecutable } from './samples';

const MINUTE_MS = 60_000;
const UNKNOWN_PATIENT = '0192f0a0-0000-7000-8000-0000000000ff';

/** Correctifs de la revue du module documents : suppression effective, ordre des contrôles, reprise, téléchargement. */
describe('documents du patient : correctifs de revue', () => {
  let app: INestApplication;
  let antivirus: FakeAntivirus;
  let storage: SwitchableStorage;
  let buckets: { quarantine: string; documents: string };
  let a: TenantFixture;
  let receptionist: UserFixture;
  let adminAgent: UserFixture;
  let patientId: string;

  const remove = (documentId: string) =>
    request(app.getHttpServer())
      .delete(`/api/v1/patients/${patientId}/documents/${documentId}`)
      .set(auth(adminAgent))
      .send({ reason: 'Document en double' });
  const objectExists = (bucket: string, key: string) =>
    storage.real.get(bucket, key).then(
      () => true,
      (error: unknown) => (error instanceof ObjectNotFoundError ? false : Promise.reject(error)),
    );
  /** Force l'état `deleted` directement en base (course avec une suppression concurrente). */
  const markDeletedBehindTheScenes = (id: string) =>
    app
      .get(TenantDb)
      .runAs(a.tenantId, (tx) =>
        tx.storedFile.update({
          where: { tenantId_id: { tenantId: a.tenantId, id } },
          data: { status: 'deleted', deletedAt: new Date(), wrappedKey: null },
        }),
      );

  beforeAll(async () => {
    ({ app, antivirus, storage, buckets } = await createDocumentsTestApp());
    a = await createTenantFixture(app, { prefix: 'doc-rev' });
    [receptionist, adminAgent] = await Promise.all([createUserWithRole(app, a, 'receptionist'), createUserWithRole(app, a, 'admin_agent')]);
    patientId = await createPatientRow(app, a);
  });

  beforeEach(() => {
    antivirus.mode = 'clean';
    storage.offline = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('suppression effective (constat 3)', () => {
    it('détruit la clé enveloppée (effacement cryptographique) et la base interdit un fichier supprimé qui garde sa clé', async () => {
      const created = await upload(app, receptionist, patientId, pdf(), 'effacer.pdf').expect(201);
      const id = created.body.data.id as string;
      expect((await fileRow(app, a.tenantId, id))!.wrappedKey).not.toBeNull();

      await remove(id).expect(204);

      expect(await fileRow(app, a.tenantId, id)).toMatchObject({ status: 'deleted', wrappedKey: null });
      const second = await upload(app, receptionist, patientId, pdf('5 0 obj (autre) endobj'), 'garde-cle.pdf').expect(201);
      await expect(
        app.get(TenantDb).runAs(a.tenantId, (tx) =>
          tx.storedFile.updateMany({ where: { tenantId: a.tenantId, id: second.body.data.id }, data: { status: 'deleted', deletedAt: new Date() } }),
        ),
      ).rejects.toThrow(/ck_files_crypto_erase/);
    });

    it('passe la ligne à « deleted » (commit) AVANT de supprimer les objets', async () => {
      const created = await upload(app, receptionist, patientId, pdf(), 'ordre.pdf').expect(201);
      const id = created.body.data.id as string;
      const statusesSeenByDeletes: (string | undefined)[] = [];
      const realDelete = storage.delete.bind(storage);
      vi.spyOn(storage, 'delete').mockImplementation(async (bucket, key) => {
        statusesSeenByDeletes.push((await fileRow(app, a.tenantId, id))?.status);
        await realDelete(bucket, key);
      });

      await remove(id).expect(204);

      expect(statusesSeenByDeletes).toEqual(['deleted', 'deleted']);
    });

    it('répond 204 même si le stockage est injoignable : ligne supprimée, clé détruite, audit écrit, échec journalisé sans donnée patient', async () => {
      const created = await upload(app, receptionist, patientId, pdf(), 'panne-suppression.pdf').expect(201);
      const id = created.body.data.id as string;
      const row = await fileRow(app, a.tenantId, id);
      const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      storage.offline = true;

      await remove(id).expect(204);
      storage.offline = false;

      expect(await fileRow(app, a.tenantId, id)).toMatchObject({ status: 'deleted', wrappedKey: null });
      expect(await auditOf(app, a.tenantId, 'files.file.deleted', id)).toHaveLength(1);
      expect(await objectExists(buckets.documents, row!.objectKey)).toBe(true);
      const logged = errors.mock.calls.filter(([context]) => typeof context === 'object' && (context as { fileId?: string }).fileId === id);
      expect(logged.length).toBeGreaterThan(0);
      expect(logged[0]![0]).toEqual({ fileId: id, bucket: expect.any(String), errorCode: 'StorageUnavailableError' });
      expect(JSON.stringify(logged)).not.toContain(row!.objectKey);
    });

    it('supprime aussi l’objet de quarantaine d’un document en attente, de façon idempotente', async () => {
      antivirus.mode = 'down';
      const created = await upload(app, receptionist, patientId, pdf(), 'attente-sup.pdf').expect(201);
      const row = await fileRow(app, a.tenantId, created.body.data.id);

      await remove(created.body.data.id).expect(204);
      await storage.delete(buckets.quarantine, row!.objectKey);

      expect(await objectExists(buckets.quarantine, row!.objectKey)).toBe(false);
    });

    it('supprime la copie promue vers « documents » si le fichier est supprimé pendant la promotion (course avec la reprise)', async () => {
      antivirus.mode = 'down';
      const created = await upload(app, receptionist, patientId, pdf(), 'course.pdf').expect(201);
      const id = created.body.data.id as string;
      const row = await fileRow(app, a.tenantId, id);
      antivirus.mode = 'clean';
      const realCopy = storage.copy.bind(storage);
      vi.spyOn(storage, 'copy').mockImplementationOnce(async (source, target) => {
        await realCopy(source, target);
        await markDeletedBehindTheScenes(id);
      });

      await app.get(FileScanRetryJob).runOnce(new Date(Date.now() + 3 * MINUTE_MS), { tenantIds: [a.tenantId] });

      expect(await fileRow(app, a.tenantId, id)).toMatchObject({ status: 'deleted' });
      expect(await objectExists(buckets.documents, row!.objectKey)).toBe(false);
      expect(await objectExists(buckets.quarantine, row!.objectKey)).toBe(false);
    });
  });

  describe('patient contrôlé avant l’antivirus (constat 4)', () => {
    it('un patient inconnu répond 404 sans consommer l’antivirus ni enregistrer de rejet', async () => {
      const scansBefore = antivirus.scans;

      const unknownWithPdf = await upload(app, receptionist, UNKNOWN_PATIENT, pdf(), 'a.pdf').expect(404);
      const unknownWithExecutable = await upload(app, receptionist, UNKNOWN_PATIENT, windowsExecutable(), 'a.pdf').expect(404);

      expect(unknownWithPdf.body.code).toBe('patient_not_found');
      expect(unknownWithExecutable.body.code).toBe('patient_not_found');
      expect(antivirus.scans).toBe(scansBefore);
      const rows = await app.get(TenantDb).runAs(a.tenantId, (tx) => tx.storedFile.count({ where: { patientId: UNKNOWN_PATIENT } }));
      expect(rows).toBe(0);
    });

    it('une fiche fusionnée n’accepte plus de document (404 patient_not_found, constat 7)', async () => {
      const merged = await createPatientRow(app, a);
      await app.get(TenantDb).runAs(a.tenantId, (tx) =>
        tx.patient.update({ where: { tenantId_id: { tenantId: a.tenantId, id: merged } }, data: { mergedIntoPatientId: patientId } }),
      );

      const res = await upload(app, receptionist, merged, pdf(), 'fusion.pdf').expect(404);

      expect(res.body.code).toBe('patient_not_found');
    });
  });

  describe('reprise : un fichier illisible n’interrompt pas le passage (constat 5)', () => {
    it('rejette le fichier dont l’objet est corrompu (scan_unavailable, audit) et traite le suivant', async () => {
      antivirus.mode = 'down';
      const broken = await upload(app, receptionist, patientId, pdf('5 0 obj (corrompu) endobj'), 'corrompu.pdf').expect(201);
      const healthy = await upload(app, receptionist, patientId, pdf('5 0 obj (sain) endobj'), 'sain.pdf').expect(201);
      const brokenRow = await fileRow(app, a.tenantId, broken.body.data.id);
      const sealed = Buffer.from(await buffer(await storage.real.get(buckets.quarantine, brokenRow!.objectKey)));
      sealed[sealed.length - 1] ^= 0xff;
      await storage.real.put(buckets.quarantine, brokenRow!.objectKey, sealed, sealed.length);
      antivirus.mode = 'clean';
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      const report = await app.get(FileScanRetryJob).runOnce(new Date(Date.now() + 3 * MINUTE_MS), { tenantIds: [a.tenantId] });

      expect(report).toMatchObject({ errors: 0, rejected: 1, available: 1 });
      expect(await fileRow(app, a.tenantId, broken.body.data.id)).toMatchObject({ status: 'rejected', rejectReason: 'scan_unavailable' });
      expect(await fileRow(app, a.tenantId, healthy.body.data.id)).toMatchObject({ status: 'available' });
      expect(await auditOf(app, a.tenantId, 'files.file.rejected', broken.body.data.id)).toHaveLength(1);
    });
  });

  describe('téléchargement : intégrité vérifiée avant tout octet (constat 6)', () => {
    it('un objet altéré répond 500 document_unreadable sans aucune donnée du document', async () => {
      const created = await upload(app, receptionist, patientId, pdf('5 0 obj (INTEGRITE-SECRETE) endobj'), 'integrite.pdf').expect(201);
      const row = await fileRow(app, a.tenantId, created.body.data.id);
      const sealed = Buffer.from(await buffer(await storage.real.get(buckets.documents, row!.objectKey)));
      sealed[sealed.length - 1] ^= 0xff;
      await storage.real.put(buckets.documents, row!.objectKey, sealed, sealed.length);
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      const res = await download(app, receptionist, patientId, created.body.data.id).expect(500);

      expect(res.body.code).toBe('document_unreadable');
      expect(JSON.stringify(res.body)).not.toContain('INTEGRITE');
      expect(res.headers['content-disposition']).toBeUndefined();
    });
  });
});
