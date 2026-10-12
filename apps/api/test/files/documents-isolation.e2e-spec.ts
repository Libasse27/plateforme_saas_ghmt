import { buffer } from 'node:stream/consumers';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { FileEnvelope } from '../../src/modules/files/domain/file-envelope';
import { createTenantFixture, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createSite } from '../iam/support';
import { auth, createDocumentsTestApp, createPatientRow, download, fileRow, upload, type SwitchableStorage } from './documents-support';
import { pdf } from './samples';

/** Isolation entre établissements (docs/13 §11.2, étape 7) et portée par site des permissions. */
describe('documents : isolation entre tenants', () => {
  let app: INestApplication;
  let storage: SwitchableStorage;
  let documentsBucket: string;
  let a: TenantFixture;
  let b: TenantFixture;
  let clerkA: UserFixture;
  let clerkB: UserFixture;
  let agentB: UserFixture;
  let patientA: string;
  let documentA: string;

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    let buckets: { documents: string };
    ({ app, storage, buckets } = await createDocumentsTestApp());
    documentsBucket = buckets.documents;
    [a, b] = await Promise.all([createTenantFixture(app, { prefix: 'iso-a' }), createTenantFixture(app, { prefix: 'iso-b' })]);
    [clerkA, clerkB, agentB] = await Promise.all([
      createUserWithRole(app, a, 'receptionist'),
      createUserWithRole(app, b, 'receptionist'),
      createUserWithRole(app, b, 'admin_agent'),
    ]);
    patientA = await createPatientRow(app, a);
    documentA = (await upload(app, clerkA, patientA, pdf('5 0 obj (SECRET-A) endobj'), 'secret-a.pdf').expect(201)).body.data.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('un utilisateur du tenant B ne liste pas les documents d’un patient du tenant A (404)', async () => {
    const res = await http().get(`/api/v1/patients/${patientA}/documents`).set(auth(clerkB)).expect(404);

    expect(res.body.code).toBe('patient_not_found');
  });

  it('ne télécharge ni ne supprime un document du tenant A, même en connaissant son id (404)', async () => {
    expect((await download(app, clerkB, patientA, documentA).expect(404)).body.code).toBe('document_not_found');
    await http()
      .delete(`/api/v1/patients/${patientA}/documents/${documentA}`)
      .set(auth(agentB))
      .send({ reason: 'Tentative inter-tenant' })
      .expect(404);
    expect((await fileRow(app, a.tenantId, documentA))!.status).toBe('available');
  });

  it('ne dépose pas sur un patient du tenant A (404)', async () => {
    expect((await upload(app, clerkB, patientA, pdf(), 'intrus.pdf').expect(404)).body.code).toBe('patient_not_found');
  });

  it('ne voit pas la ligne du tenant A en base (RLS), même avec un patient homonyme du tenant B', async () => {
    const patientB = await createPatientRow(app, b);

    expect(await app.get(TenantDb).runAs(b.tenantId, (tx) => tx.storedFile.count({ where: { id: documentA } }))).toBe(0);
    expect((await download(app, clerkB, patientB, documentA).expect(404)).body.code).toBe('document_not_found');
  });

  it('chiffre l’objet avec une clé liée au tenant A : la clé du tenant A ne l’ouvre pas sous le tenant B', async () => {
    const row = await fileRow(app, a.tenantId, documentA);
    const sealed = await buffer(await storage.real.get(documentsBucket, row!.objectKey));
    const envelope = app.get(FileEnvelope);

    expect(sealed.includes(Buffer.from('SECRET-A'))).toBe(false);
    expect(envelope.open(a.tenantId, documentA, row!.wrappedKey, sealed).includes(Buffer.from('SECRET-A'))).toBe(true);
    expect(() => envelope.open(b.tenantId, documentA, row!.wrappedKey, sealed)).toThrow();
  });

  it('applique la portée par site de la permission : patient d’un autre site → 404', async () => {
    const [siteNorth, siteSouth] = await Promise.all([createSite(app, a, 'NORD'), createSite(app, a, 'SUD')]);
    const northClerk = await createUserWithRole(app, a, 'receptionist', { scopeType: 'site', scopeId: siteNorth });
    const southPatient = await createPatientRow(app, a, siteSouth);
    const northPatient = await createPatientRow(app, a, siteNorth);

    await http().get(`/api/v1/patients/${southPatient}/documents`).set(auth(northClerk)).expect(404);
    await upload(app, northClerk, southPatient, pdf(), 'sud.pdf').expect(404);
    await upload(app, northClerk, northPatient, pdf(), 'nord.pdf').expect(201);
  });
});
