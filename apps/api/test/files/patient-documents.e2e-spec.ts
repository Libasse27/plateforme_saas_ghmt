import { buffer } from 'node:stream/consumers';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES } from '@ghmt/shared';
import { FileScanRetryJob } from '../../src/modules/files/jobs/file-scan-retry.job';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { ObjectNotFoundError } from '../../src/infrastructure/storage/storage-errors';
import { createTenantFixture, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { patchSubscription } from '../subscriptions/subscription-fixtures';
import {
  auditOf,
  auth,
  createDocumentsTestApp,
  createPatientRow,
  download,
  fileRow,
  sha256,
  upload,
  type FakeAntivirus,
  type SwitchableStorage,
} from './documents-support';
import { METADATA_MARKER, jpegWithExif, pdf, windowsExecutable } from './samples';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

describe('documents du patient (HTTP, docs/13 §5)', () => {
  let app: INestApplication;
  let antivirus: FakeAntivirus;
  let storage: SwitchableStorage;
  let buckets: { quarantine: string; documents: string };
  let a: TenantFixture;
  let receptionist: UserFixture;
  let adminAgent: UserFixture;
  let doctor: UserFixture;
  let accountant: UserFixture;
  let patientId: string;

  const http = () => request(app.getHttpServer());
  const list = (user: UserFixture, patient = patientId) => http().get(`/api/v1/patients/${patient}/documents`).set(auth(user));
  const remove = (user: UserFixture, documentId: string, body: unknown = { reason: 'Document en double' }, patient = patientId) =>
    http().delete(`/api/v1/patients/${patient}/documents/${documentId}`).set(auth(user)).send(body as object);
  const rowsOfPatient = (patient: string) =>
    app.get(TenantDb).runAs(a.tenantId, (tx) => tx.storedFile.findMany({ where: { patientId: patient }, orderBy: { createdAt: 'asc' } }));

  beforeAll(async () => {
    ({ app, antivirus, storage, buckets } = await createDocumentsTestApp());
    a = await createTenantFixture(app, { prefix: 'doc-a' });
    [receptionist, adminAgent, doctor, accountant] = await Promise.all([
      createUserWithRole(app, a, 'receptionist'),
      createUserWithRole(app, a, 'admin_agent'),
      createUserWithRole(app, a, 'doctor'),
      createUserWithRole(app, a, 'accountant'),
    ]);
    patientId = await createPatientRow(app, a);
  });

  beforeEach(() => {
    antivirus.mode = 'clean';
    storage.offline = false;
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('dépôt, liste et téléchargement', () => {
    it('dépose un PDF (201 available), le liste puis le restitue à l’identique avec les en-têtes de sécurité', async () => {
      const content = pdf();

      const created = await upload(app, receptionist, patientId, content, 'Carte d’identité.pdf').expect(201);
      const listed = await list(doctor).expect(200);
      const fetched = await download(app, doctor, patientId, created.body.data.id).expect(200);

      expect(created.body.data).toMatchObject({
        purpose: 'identity',
        status: 'available',
        originalName: 'Carte d’identité.pdf',
        mimeType: 'application/pdf',
        sizeBytes: content.length,
        createdBy: { id: receptionist.userId, fullName: 'Utilisateur receptionist' },
      });
      expect(listed.body.data.items.map((item: { id: string }) => item.id)).toContain(created.body.data.id);
      expect(sha256(fetched.body as Buffer)).toBe(sha256(content));
      expect(fetched.headers['content-type']).toBe('application/pdf');
      expect(fetched.headers['content-disposition']).toBe(
        `attachment; filename="Carte d_identit_.pdf"; filename*=UTF-8''Carte%20d%E2%80%99identit%C3%A9.pdf`,
      );
      expect(fetched.headers['x-content-type-options']).toBe('nosniff');
      expect(fetched.headers['cache-control']).toBe('no-store');
      expect(fetched.headers['content-length']).toBe(String(content.length));
    });

    it('stocke un objet chiffré dans `documents`, rien en quarantaine, et une clé d’objet sans nom', async () => {
      const content = pdf('5 0 obj (MARQUEUR-EN-CLAIR) endobj');
      const created = await upload(app, receptionist, patientId, content, 'Ndiaye Fatou.pdf').expect(201);
      const row = await fileRow(app, a.tenantId, created.body.data.id);

      const stored = await buffer(await storage.real.get(buckets.documents, row!.objectKey));

      expect(row!.objectKey).toMatch(new RegExp(`^t/${a.tenantId}/files/\\d{4}/\\d{2}/${created.body.data.id}$`));
      expect(stored.includes(Buffer.from('MARQUEUR-EN-CLAIR'))).toBe(false);
      expect(stored.includes(Buffer.from('%PDF'))).toBe(false);
      expect(Buffer.from(row!.originalName).includes(Buffer.from('Ndiaye'))).toBe(false);
      expect(row!.sha256).toBe(sha256(content));
      await expect(storage.real.get(buckets.quarantine, row!.objectKey)).rejects.toBeInstanceOf(ObjectNotFoundError);
    });

    it('retire les métadonnées EXIF d’une photo avant stockage', async () => {
      const created = await upload(app, receptionist, patientId, jpegWithExif(), 'photo.jpg', 'insurance_card').expect(201);
      const fetched = await download(app, receptionist, patientId, created.body.data.id).expect(200);

      expect(created.body.data).toMatchObject({ mimeType: 'image/jpeg', purpose: 'insurance_card' });
      expect((fetched.body as Buffer).includes(Buffer.from(METADATA_MARKER))).toBe(false);
      expect(fetched.headers['content-type']).toBe('image/jpeg');
    });

    it('liste au plus 100 documents, les plus récents d’abord, statuts available et pending seulement', async () => {
      const other = await createPatientRow(app, a);
      const first = await upload(app, receptionist, other, pdf(), 'premier.pdf').expect(201);
      const second = await upload(app, receptionist, other, pdf(), 'second.pdf').expect(201);
      await upload(app, receptionist, other, windowsExecutable(), 'refus.pdf').expect(415);

      const listed = await list(receptionist, other).expect(200);

      expect(listed.body.data.items.map((item: { id: string }) => item.id)).toEqual([second.body.data.id, first.body.data.id]);
    });

    it('audite le dépôt, la liste et le téléchargement (jamais le nom ni le contenu)', async () => {
      const created = await upload(app, receptionist, patientId, pdf(), 'audit.pdf').expect(201);
      await list(receptionist).expect(200);
      await download(app, doctor, patientId, created.body.data.id).expect(200);

      const [uploaded] = await auditOf(app, a.tenantId, 'files.file.uploaded', created.body.data.id);
      const [downloaded] = await auditOf(app, a.tenantId, 'files.file.downloaded', created.body.data.id);
      const listed = await auditOf(app, a.tenantId, 'files.file.listed');

      expect(uploaded).toMatchObject({ actorUserId: receptionist.userId, patientId, resourceType: 'file' });
      expect(uploaded!.changes).toMatchObject({ purpose: 'identity', status: 'available', mimeType: 'application/pdf' });
      expect(JSON.stringify(uploaded!.changes)).not.toContain('audit.pdf');
      expect(downloaded).toMatchObject({ actorUserId: doctor.userId, patientId });
      expect(listed.at(-1)).toMatchObject({ actorUserId: receptionist.userId, patientId });
    });
  });

  describe('contrôles du contenu', () => {
    it('refuse un exécutable renommé en .pdf (415 type_not_allowed) et trace le rejet', async () => {
      const res = await upload(app, receptionist, patientId, windowsExecutable(), 'facture.pdf').expect(415);
      const rejected = (await rowsOfPatient(patientId)).filter((row) => row.rejectReason === 'type_not_allowed');

      expect(res.body.code).toBe('type_not_allowed');
      expect(rejected.at(-1)).toMatchObject({ status: 'rejected', mimeType: 'application/x-msdownload' });
      expect(await auditOf(app, a.tenantId, 'files.file.rejected', rejected.at(-1)!.id)).toHaveLength(1);
    });

    it('refuse un PDF contenant du JavaScript (422 active_content)', async () => {
      const res = await upload(app, receptionist, patientId, pdf('5 0 obj << /S /JavaScript /JS (app.alert(1)) >> endobj'), 'actif.pdf').expect(422);

      expect(res.body.code).toBe('active_content');
    });

    it('refuse un fichier infecté (422 infected), supprime l’objet de la quarantaine et trace le rejet', async () => {
      antivirus.mode = 'infected';

      const res = await upload(app, receptionist, patientId, pdf(), 'eicar.pdf').expect(422);
      const row = (await rowsOfPatient(patientId)).filter((r) => r.rejectReason === 'infected').at(-1)!;
      const [audit] = await auditOf(app, a.tenantId, 'files.file.rejected', row.id);

      expect(res.body.code).toBe('infected');
      expect(row.status).toBe('rejected');
      expect(audit!.changes).toMatchObject({ reason: 'infected', signature: 'Eicar-Test-Signature' });
      await expect(storage.real.get(buckets.quarantine, row.objectKey)).rejects.toBeInstanceOf(ObjectNotFoundError);
    });

    it('signale un virus dans un fichier de type refusé comme une infection (message antivirus)', async () => {
      antivirus.mode = 'infected';

      const res = await upload(app, receptionist, patientId, windowsExecutable(), 'virus.pdf').expect(422);
      const row = (await rowsOfPatient(patientId)).at(-1)!;

      expect(res.body.code).toBe('infected');
      expect(row).toMatchObject({ status: 'rejected', rejectReason: 'infected' });
    });

    it('refuse un fichier de type non accepté même si l’antivirus est indisponible', async () => {
      antivirus.mode = 'down';

      expect((await upload(app, receptionist, patientId, windowsExecutable(), 'x.pdf').expect(415)).body.code).toBe('type_not_allowed');
    });

    it('refuse un fichier de plus de 10 Mo (413 file_too_large) sans rien enregistrer', async () => {
      const before = (await rowsOfPatient(patientId)).length;

      const res = await upload(app, receptionist, patientId, Buffer.concat([pdf(), Buffer.alloc(MAX_UPLOAD_BYTES)]), 'gros.pdf').expect(413);

      expect(res.body.code).toBe('file_too_large');
      expect(await rowsOfPatient(patientId)).toHaveLength(before);
    });

    it('refuse un dépôt sans fichier, vide, ou d’usage inconnu (422)', async () => {
      await http().post(`/api/v1/patients/${patientId}/documents`).set(auth(receptionist)).field('purpose', 'identity').expect(422);
      await upload(app, receptionist, patientId, Buffer.alloc(0), 'vide.pdf').expect(422);
      const res = await upload(app, receptionist, patientId, pdf(), 'x.pdf', 'clinical_report').expect(422);

      expect(res.body.errors[0].path).toBe('purpose');
    });

    it('refuse un multipart invalide (deux fichiers, champ de fichier inconnu) en 422 invalid_multipart', async () => {
      const twoFiles = await http()
        .post(`/api/v1/patients/${patientId}/documents`)
        .set(auth(receptionist))
        .field('purpose', 'identity')
        .attach('file', pdf(), 'a.pdf')
        .attach('file', pdf(), 'b.pdf')
        .expect(422);
      const unknownField = await http()
        .post(`/api/v1/patients/${patientId}/documents`)
        .set(auth(receptionist))
        .field('purpose', 'identity')
        .attach('autre', pdf(), 'a.pdf')
        .expect(422);

      expect(twoFiles.body.errors[0]).toMatchObject({ path: 'file', code: 'invalid_multipart' });
      expect(unknownField.body.errors[0]).toMatchObject({ path: 'file', code: 'invalid_multipart' });
    });

    it('refuse un corps JSON (multipart obligatoire)', async () => {
      await http().post(`/api/v1/patients/${patientId}/documents`).set(auth(receptionist)).send({ purpose: 'identity' }).expect(422);
    });
  });

  describe('antivirus indisponible (docs/13 D5)', () => {
    it('accepte en « pending » quand clamd est coupé, ne sert pas le fichier, puis la tâche le rend disponible', async () => {
      antivirus.mode = 'down';
      const content = pdf();
      const created = await upload(app, receptionist, patientId, content, 'en-attente.pdf').expect(201);
      const id = created.body.data.id as string;

      expect(created.body.data.status).toBe('pending');
      expect((await list(receptionist).expect(200)).body.data.items.find((item: { id: string }) => item.id === id)?.status).toBe('pending');
      expect((await download(app, receptionist, patientId, id).expect(404)).body.code).toBe('document_not_found');
      expect((await fileRow(app, a.tenantId, id))!.scanAttempts).toBe(1);

      const job = app.get(FileScanRetryJob);
      const stillDown = await job.runOnce(new Date(Date.now() + 3 * MINUTE_MS), { tenantIds: [a.tenantId] });
      antivirus.mode = 'clean';
      const recovered = await job.runOnce(new Date(Date.now() + 3 * MINUTE_MS), { tenantIds: [a.tenantId] });

      expect(stillDown).toMatchObject({ available: 0, antivirusUnavailable: true });
      expect(recovered).toMatchObject({ available: 1, rejected: 0 });
      expect((await fileRow(app, a.tenantId, id))).toMatchObject({ status: 'available', scanAttempts: 3 });
      expect(sha256((await download(app, receptionist, patientId, id).expect(200)).body as Buffer)).toBe(sha256(content));
      expect(await auditOf(app, a.tenantId, 'files.file.available', id)).toHaveLength(1);
    });

    it('ne reprend pas un dépôt de moins de 2 minutes (dépôt peut-être en cours)', async () => {
      antivirus.mode = 'down';
      const created = await upload(app, receptionist, patientId, pdf(), 'recent.pdf').expect(201);
      antivirus.mode = 'clean';

      await app.get(FileScanRetryJob).runOnce(new Date(), { tenantIds: [a.tenantId] });

      expect((await fileRow(app, a.tenantId, created.body.data.id))!.status).toBe('pending');
    });

    it('rejette après 24 h sans analyse (scan_unavailable) et supprime l’objet en quarantaine', async () => {
      antivirus.mode = 'down';
      const created = await upload(app, receptionist, patientId, pdf(), 'perime.pdf').expect(201);
      const row = await fileRow(app, a.tenantId, created.body.data.id);

      const report = await app.get(FileScanRetryJob).runOnce(new Date(Date.now() + 25 * HOUR_MS), { tenantIds: [a.tenantId] });

      expect(report.rejected).toBeGreaterThanOrEqual(1);
      expect(await fileRow(app, a.tenantId, row!.id)).toMatchObject({ status: 'rejected', rejectReason: 'scan_unavailable' });
      await expect(storage.real.get(buckets.quarantine, row!.objectKey)).rejects.toBeInstanceOf(ObjectNotFoundError);
    });

    it('parcourt tous les établissements sans liste explicite, et la tâche planifiée ne tourne pas sous test', async () => {
      const job = app.get(FileScanRetryJob);

      await expect(job.scheduledRun()).resolves.toBeUndefined();
      expect(await job.runOnce(new Date())).toMatchObject({ errors: 0 });
    });

    it('rejette un fichier en attente dont l’objet de quarantaine n’existe pas (dépôt interrompu)', async () => {
      antivirus.mode = 'down';
      const created = await upload(app, receptionist, patientId, pdf(), 'interrompu.pdf').expect(201);
      const row = await fileRow(app, a.tenantId, created.body.data.id);
      await storage.real.delete(buckets.quarantine, row!.objectKey);
      antivirus.mode = 'clean';

      await app.get(FileScanRetryJob).runOnce(new Date(Date.now() + 3 * MINUTE_MS), { tenantIds: [a.tenantId] });

      expect(await fileRow(app, a.tenantId, row!.id)).toMatchObject({ status: 'rejected', rejectReason: 'scan_unavailable' });
    });

    it('compte une erreur par établissement en échec sans interrompre les autres', async () => {
      const report = await app.get(FileScanRetryJob).runOnce(new Date(), { tenantIds: ['pas-un-uuid', a.tenantId] });

      expect(report.errors).toBe(1);
    });

    it('rejette un fichier infecté détecté lors de la reprise', async () => {
      antivirus.mode = 'down';
      const created = await upload(app, receptionist, patientId, pdf(), 'reprise-infectee.pdf').expect(201);
      antivirus.mode = 'infected';

      await app.get(FileScanRetryJob).runOnce(new Date(Date.now() + 3 * MINUTE_MS), { tenantIds: [a.tenantId] });

      expect(await fileRow(app, a.tenantId, created.body.data.id)).toMatchObject({ status: 'rejected', rejectReason: 'infected' });
    });
  });

  describe('sonde /health/ready (docs/13 §5.1)', () => {
    it('expose l’état du stockage et de l’antivirus, sans faire échouer la sonde', async () => {
      const up = await http().get('/api/v1/health/ready').expect(200);
      storage.offline = true;
      antivirus.mode = 'down';
      const down = await http().get('/api/v1/health/ready').expect(200);

      expect(up.body.data.checks).toMatchObject({ storage: 'up', antivirus: 'up' });
      expect(down.body.data).toMatchObject({ status: 'ok', checks: { storage: 'down', antivirus: 'down' } });
    });
  });

  describe('stockage indisponible', () => {
    it('répond 503 storage_unavailable et ne laisse aucune ligne', async () => {
      const before = (await rowsOfPatient(patientId)).length;
      storage.offline = true;

      const res = await upload(app, receptionist, patientId, pdf(), 'panne.pdf').expect(503);

      expect(res.body.code).toBe('storage_unavailable');
      expect(await rowsOfPatient(patientId)).toHaveLength(before);
    });

    it('répond 503 au téléchargement quand le stockage est injoignable', async () => {
      const created = await upload(app, receptionist, patientId, pdf(), 'panne2.pdf').expect(201);
      storage.offline = true;

      expect((await download(app, receptionist, patientId, created.body.data.id).expect(503)).body.code).toBe('storage_unavailable');
      storage.offline = false;
      expect((await fileRow(app, a.tenantId, created.body.data.id))!.status).toBe('available');
    });
  });

  describe('quota de stockage (docs/13 D6)', () => {
    it('refuse le dépôt au-delà de storageGb (403 plan_limit_reached { limit, current })', async () => {
      const limited = await createTenantFixture(app, { prefix: 'doc-quota' });
      const clerk = await createUserWithRole(app, limited, 'receptionist');
      const patient = await createPatientRow(app, limited);
      await patchSubscription(app, limited.tenantId, { overrides: { limits: { storageGb: 0 } } });

      const res = await upload(app, clerk, patient, pdf(), 'quota.pdf').expect(403);

      expect(res.body).toMatchObject({ code: 'plan_limit_reached', details: { metric: 'storageGb', limit: 0, current: 0 } });
    });
  });

  describe('suppression', () => {
    it('supprime avec motif (204) : objet retiré du stockage, ligne « deleted », audit du motif', async () => {
      const created = await upload(app, receptionist, patientId, pdf(), 'a-supprimer.pdf').expect(201);
      const id = created.body.data.id as string;
      const row = await fileRow(app, a.tenantId, id);

      await remove(adminAgent, id, { reason: 'Pièce périmée remplacée' }).expect(204);

      expect(await fileRow(app, a.tenantId, id)).toMatchObject({ status: 'deleted' });
      expect((await fileRow(app, a.tenantId, id))!.deletedAt).toBeInstanceOf(Date);
      await expect(storage.real.get(buckets.documents, row!.objectKey)).rejects.toBeInstanceOf(ObjectNotFoundError);
      expect((await list(adminAgent).expect(200)).body.data.items.map((item: { id: string }) => item.id)).not.toContain(id);
      await download(app, adminAgent, patientId, id).expect(404);
      await remove(adminAgent, id).expect(404);
      const [audit] = await auditOf(app, a.tenantId, 'files.file.deleted', id);
      expect(audit).toMatchObject({ actorUserId: adminAgent.userId, patientId, changes: { reason: 'Pièce périmée remplacée' } });
    });

    it('supprime un document en attente d’analyse (objet en quarantaine)', async () => {
      antivirus.mode = 'down';
      const created = await upload(app, receptionist, patientId, pdf(), 'attente.pdf').expect(201);
      const row = await fileRow(app, a.tenantId, created.body.data.id);

      await remove(adminAgent, created.body.data.id).expect(204);

      await expect(storage.real.get(buckets.quarantine, row!.objectKey)).rejects.toBeInstanceOf(ObjectNotFoundError);
    });

    it('exige un motif de 5 à 500 caractères (422)', async () => {
      const created = await upload(app, receptionist, patientId, pdf(), 'motif.pdf').expect(201);

      await remove(adminAgent, created.body.data.id, {}).expect(422);
      await remove(adminAgent, created.body.data.id, { reason: 'non' }).expect(422);
    });
  });

  describe('permissions (docs/13 §4)', () => {
    let documentId: string;

    beforeAll(async () => {
      documentId = (await upload(app, receptionist, patientId, pdf(), 'droits.pdf').expect(201)).body.data.id;
    });

    it('le médecin lit et télécharge, mais ne dépose ni ne supprime', async () => {
      await list(doctor).expect(200);
      await download(app, doctor, patientId, documentId).expect(200);
      await upload(app, doctor, patientId, pdf(), 'x.pdf').expect(403);
      await remove(doctor, documentId).expect(403);
    });

    it('le réceptionniste dépose mais ne supprime pas', async () => {
      await remove(receptionist, documentId).expect(403);
    });

    it('le comptable et l’administrateur de l’établissement n’ont pas accès aux documents', async () => {
      await list(accountant).expect(403);
      await list({ ...accountant, token: a.adminToken }).expect(403);
      await download(app, { token: a.adminToken }, patientId, documentId).expect(403);
    });

    it('répond 404 patient_not_found pour un patient inconnu', async () => {
      const unknown = '0192f0a0-0000-7000-8000-0000000000ff';

      expect((await list(receptionist, unknown).expect(404)).body.code).toBe('patient_not_found');
      expect((await upload(app, receptionist, unknown, pdf(), 'x.pdf').expect(404)).body.code).toBe('patient_not_found');
      expect((await download(app, receptionist, unknown, documentId).expect(404)).body.code).toBe('document_not_found');
    });

    it('répond 404 document_not_found pour un document d’un autre patient du même établissement', async () => {
      const other = await createPatientRow(app, a);

      expect((await download(app, receptionist, other, documentId).expect(404)).body.code).toBe('document_not_found');
      expect((await remove(adminAgent, documentId, undefined, other).expect(404)).body.code).toBe('document_not_found');
    });

    it('traite un identifiant non UUID comme introuvable (404)', async () => {
      await http().get(`/api/v1/patients/pas-un-uuid/documents`).set(auth(receptionist)).expect(404);
    });
  });
});
