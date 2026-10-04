import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { createTenantFixture, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createSite } from '../iam/support';
import { createTestApp } from '../helpers/test-app';
import { createReceptionistWith } from './patient-fixtures';

const IPP_PATTERN = /^P\d{2}-\d{7}$/;

describe('patients (HTTP)', () => {
  let app: INestApplication;
  let tenantDb: TenantDb;
  let a: TenantFixture;
  let b: TenantFixture;
  let receptionist: UserFixture;
  let doctor: UserFixture;
  let accountant: UserFixture;
  let stockManager: UserFixture;
  let manager: UserFixture;
  let otherTenantReceptionist: UserFixture;
  let counter = 0;

  const http = () => request(app.getHttpServer());
  const auth = (user: UserFixture) => ({ Authorization: `Bearer ${user.token}` });

  /** Numéro E.164 unique par appel (évite les faux doublons entre tests). */
  function uniquePhone(): string {
    counter += 1;
    return `+22177${String(1000000 + counter * 7919).slice(-7)}`;
  }

  function newPatient(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    counter += 1;
    return { lastName: `Patient${counter}`, firstName: 'Test', birthDate: '1990-01-01', sex: 'female', phone: uniquePhone(), ...overrides };
  }

  /** Recherche par POST (C1) : aucun terme dans l'URL. */
  const search = (user: UserFixture, body: Record<string, unknown>) => http().post('/api/v1/patients/search').set(auth(user)).send(body);
  const ids = (res: { body: { data: { id: string }[] } }): string[] => res.body.data.map((p) => p.id);

  /** Modification avec la version courante du patient (If-Match obligatoire). */
  const patchPatient = (user: UserFixture, patient: Record<string, any>, body: Record<string, unknown>) =>
    http().patch(`/api/v1/patients/${patient['id']}`).set(auth(user)).set('If-Match', `"${patient['rowVersion']}"`).send(body);

  async function createPatient(user: UserFixture, body: Record<string, unknown> = newPatient()) {
    const res = await http().post('/api/v1/patients').set(auth(user)).send(body).expect(201);
    return res.body.data as Record<string, any>;
  }

  beforeAll(async () => {
    app = await createTestApp();
    tenantDb = app.get(TenantDb);
    [a, b] = await Promise.all([createTenantFixture(app, { prefix: 'pat-a' }), createTenantFixture(app, { prefix: 'pat-b' })]);
    receptionist = await createUserWithRole(app, a, 'receptionist');
    doctor = await createUserWithRole(app, a, 'doctor');
    accountant = await createUserWithRole(app, a, 'accountant');
    stockManager = await createUserWithRole(app, a, 'stock_manager');
    manager = await createReceptionistWith(app, a, ['patients:patient:delete']);
    otherTenantReceptionist = await createUserWithRole(app, b, 'receptionist');
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('création et lecture', () => {
    it('crée un patient avec un IPP au bon format et le relit déchiffré', async () => {
      const body = newPatient({ lastName: 'Ndiaye', firstName: 'Fatou', email: 'Fatou@Example.org', nationalId: '1234567890123', address: '12 rue des Écoles', city: 'Dakar' });

      const created = await http().post('/api/v1/patients').set(auth(receptionist)).send(body).expect(201);
      const read = await http().get(`/api/v1/patients/${created.body.data.id}`).set(auth(receptionist)).expect(200);

      expect(created.body.data.ipp).toMatch(IPP_PATTERN);
      expect(read.body).toMatchObject({
        success: true,
        data: { lastName: 'Ndiaye', firstName: 'Fatou', phone: body['phone'], email: 'fatou@example.org', nationalId: '1234567890123', address: '12 rue des Écoles', city: 'Dakar' },
      });
      expect(read.headers['etag']).toBe(`"${read.body.data.rowVersion}"`);
    });

    it('attribue des IPP consécutifs et distincts', async () => {
      const first = await createPatient(receptionist);
      const second = await createPatient(receptionist);

      expect(Number(second.ipp.slice(4)) - Number(first.ipp.slice(4))).toBe(1);
    });

    it('stocke téléphone, email, pièce d’identité et adresse chiffrés en base, jamais en clair', async () => {
      const body = newPatient({ email: 'secret.mail@example.org', nationalId: 'CNI-998877', address: 'Adresse très secrète' });
      const created = await createPatient(receptionist, body);

      const stored = await tenantDb.runAs(a.tenantId, (tx) => tx.patient.findFirstOrThrow({ where: { id: created['id'] } }));

      for (const [blob, clear] of [
        [stored.phoneEnc, body['phone']],
        [stored.emailEnc, 'secret.mail@example.org'],
        [stored.nationalIdEnc, 'CNI-998877'],
        [stored.addressEnc, 'Adresse très secrète'],
      ] as const) {
        expect(blob).toBeInstanceOf(Uint8Array);
        expect(Buffer.from(blob!).toString('utf8')).not.toContain(String(clear));
        expect(Buffer.from(blob!).toString('latin1')).not.toContain(String(clear));
      }
      expect(stored.phoneBidx).toHaveLength(32);
      expect(stored.searchName).toBe(`${String(body['lastName']).toLowerCase()} test`);
    });

    it('ne renvoie jamais de colonne chiffrée ni d’index aveugle', async () => {
      const created = await createPatient(receptionist);

      const res = await http().get(`/api/v1/patients/${created['id']}`).set(auth(receptionist)).expect(200);

      expect(JSON.stringify(res.body)).not.toMatch(/_enc|_bidx|Enc"|Bidx"|searchName/);
    });
  });

  describe('doublons', () => {
    it('refuse avec 409 patient_duplicate un patient de même nom et date de naissance (accents ignorés)', async () => {
      await createPatient(receptionist, newPatient({ lastName: 'Sène', firstName: 'Aïssatou', birthDate: '1985-04-12', phone: undefined }));

      const res = await http()
        .post('/api/v1/patients')
        .set(auth(receptionist))
        .send({ lastName: 'SENE', firstName: 'aissatou', birthDate: '1985-04-12' })
        .expect(409);

      expect(res.body.code).toBe('patient_duplicate');
    });

    it('renvoie dans details.candidates l’identité minimale des doublons probables (5 au plus)', async () => {
      const phone = uniquePhone();
      const first = await createPatient(receptionist, newPatient({ lastName: 'Candidat', firstName: 'Premier', birthDate: '1979-08-09', phone, email: 'candidat@example.org' }));
      for (let i = 0; i < 6; i += 1) {
        await http().post('/api/v1/patients?force=true').set(auth(receptionist)).send(newPatient({ phone, forceReason: 'Test des candidats' })).expect(201);
      }

      const res = await http().post('/api/v1/patients').set(auth(receptionist)).send(newPatient({ phone })).expect(409);

      const candidates = res.body.details.candidates as Record<string, unknown>[];
      expect(candidates).toHaveLength(5);
      expect(candidates.every((c) => Object.keys(c).sort().join() === 'birthYear,fullName,id,ipp')).toBe(true);
      expect(res.body.error.details.candidates).toHaveLength(5);
      const firstCandidate = candidates.find((c) => c['id'] === first['id']);
      expect(firstCandidate).toEqual({ id: first['id'], ipp: first['ipp'], fullName: 'Premier CANDIDAT', birthYear: 1979 });
      expect(JSON.stringify(res.body)).not.toContain(phone);
      expect(JSON.stringify(res.body)).not.toContain('candidat@example.org');
    });

    it('détecte un nom et un prénom inversés à la même date de naissance', async () => {
      await createPatient(receptionist, newPatient({ lastName: 'Diallo', firstName: 'Mamadou', birthDate: '1980-03-03', phone: undefined }));

      const res = await http()
        .post('/api/v1/patients')
        .set(auth(receptionist))
        .send({ lastName: 'Mamadou', firstName: 'Diallo', birthDate: '1980-03-03' })
        .expect(409);

      expect(res.body.code).toBe('patient_duplicate');
    });

    it('tolère ± 2 ans quand la date saisie est estimée, pas au-delà', async () => {
      await createPatient(receptionist, newPatient({ lastName: 'Estimee', firstName: 'Awa', birthDate: '1980-06-01', phone: undefined }));

      await http().post('/api/v1/patients').set(auth(receptionist)).send({ lastName: 'Estimee', firstName: 'Awa', birthDate: '1982-01-01', birthDateEstimated: true }).expect(409);
      await http().post('/api/v1/patients').set(auth(receptionist)).send({ lastName: 'Estimee', firstName: 'Awa', birthDate: '1983-01-01', birthDateEstimated: true }).expect(201);
    });

    it('n’applique pas la tolérance quand ni la saisie ni la fiche existante ne sont estimées', async () => {
      await createPatient(receptionist, newPatient({ lastName: 'Exacte', firstName: 'Awa', birthDate: '1980-06-01', phone: undefined }));

      await http().post('/api/v1/patients').set(auth(receptionist)).send({ lastName: 'Exacte', firstName: 'Awa', birthDate: '1982-01-01' }).expect(201);
    });

    it('tolère ± 2 ans quand c’est la fiche existante qui porte une date estimée', async () => {
      await createPatient(receptionist, newPatient({ lastName: 'Ancienne', firstName: 'Estimation', birthDate: '1960-01-01', birthDateEstimated: true, phone: undefined }));

      await http().post('/api/v1/patients').set(auth(receptionist)).send({ lastName: 'Ancienne', firstName: 'Estimation', birthDate: '1962-12-31' }).expect(409);
      await http().post('/api/v1/patients').set(auth(receptionist)).send({ lastName: 'Ancienne', firstName: 'Estimation', birthDate: '1963-01-01' }).expect(201);
    });

    it('refuse avec 409 un patient ayant le même téléphone', async () => {
      const phone = uniquePhone();
      await createPatient(receptionist, newPatient({ phone }));

      const res = await http().post('/api/v1/patients').set(auth(receptionist)).send(newPatient({ phone })).expect(409);

      expect(res.body.code).toBe('patient_duplicate');
    });

    it('refuse avec 409 un patient ayant la même pièce d’identité (index aveugle)', async () => {
      await createPatient(receptionist, newPatient({ nationalId: 'CNI-DOUBLON-77' }));

      const res = await http().post('/api/v1/patients').set(auth(receptionist)).send(newPatient({ nationalId: 'cni-doublon-77' })).expect(409);

      expect(res.body.code).toBe('patient_duplicate');
    });

    it('exige un motif pour forcer : 422 force_reason_required sans forceReason', async () => {
      const phone = uniquePhone();
      await createPatient(receptionist, newPatient({ phone }));

      const res = await http().post('/api/v1/patients?force=true').set(auth(receptionist)).send(newPatient({ phone })).expect(422);

      expect(res.body.code).toBe('force_reason_required');
    });

    it('refuse un motif de forçage trop court (422 validation_failed)', async () => {
      const res = await http().post('/api/v1/patients?force=true').set(auth(receptionist)).send(newPatient({ forceReason: 'ab' })).expect(422);

      expect(res.body.code).toBe('validation_failed');
    });

    it('accepte le doublon avec ?force=true et forceReason, et audite le forçage et son motif', async () => {
      const phone = uniquePhone();
      await createPatient(receptionist, newPatient({ phone }));

      const created = await http()
        .post('/api/v1/patients?force=true')
        .set(auth(receptionist))
        .send(newPatient({ phone, forceReason: 'Homonyme confirmé par la pièce d’identité' }))
        .expect(201);

      const log = await tenantDb.runAs(a.tenantId, (tx) =>
        tx.auditLog.findFirstOrThrow({ where: { action: 'patient.created', resourceId: created.body.data.id } }),
      );
      expect(log.changes).toMatchObject({ forced: true, forceReason: 'Homonyme confirmé par la pièce d’identité' });
      expect((log.changes as { fields: string[] }).fields).not.toContain('forceReason');
      expect(JSON.stringify(log.changes)).not.toContain(phone);
    });

    it('ne considère pas comme doublon un homonyme né un autre jour', async () => {
      await createPatient(receptionist, { lastName: 'Homonyme', firstName: 'Marc', birthDate: '1970-01-01' });

      await http().post('/api/v1/patients').set(auth(receptionist)).send({ lastName: 'Homonyme', firstName: 'Marc', birthDate: '1971-01-01' }).expect(201);
    });

    it('ignore les patients des autres tenants pour la détection de doublon', async () => {
      const phone = uniquePhone();
      await createPatient(otherTenantReceptionist, newPatient({ phone }));

      await http().post('/api/v1/patients').set(auth(receptionist)).send(newPatient({ phone })).expect(201);
    });
  });

  describe('recherche (POST /patients/search)', () => {
    it('trouve par nom sans tenir compte des accents ni de la casse', async () => {
      const created = await createPatient(receptionist, newPatient({ lastName: 'Zéphyrin', firstName: 'Élodie' }));

      const res = await search(receptionist, { q: 'ZEPHYR' }).expect(200);

      expect(ids(res)).toContain(created['id']);
    });

    it('trouve par téléphone exact via l’index aveugle', async () => {
      const phone = uniquePhone();
      const created = await createPatient(receptionist, newPatient({ phone }));
      await createPatient(receptionist, newPatient());

      const res = await search(receptionist, { phone }).expect(200);

      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe(created['id']);
    });

    it('trouve par IPP', async () => {
      const created = await createPatient(receptionist);

      const res = await search(receptionist, { ipp: created['ipp'] }).expect(200);

      expect(ids(res)).toEqual([created['id']]);
    });

    it('refuse avec 422 search_criteria_required une recherche sans critère', async () => {
      for (const body of [{}, { limit: 10 }]) {
        const res = await search(receptionist, body).expect(422);
        expect(res.body.code).toBe('search_criteria_required');
      }
    });

    it('n’expose plus GET /patients (aucun terme de recherche dans une URL)', async () => {
      await http().get('/api/v1/patients').query({ q: 'diop' }).set(auth(receptionist)).expect(404);
      await http().get('/api/v1/patients').set(auth(receptionist)).expect(404);
    });

    it('renvoie la forme { id, ipp, firstName, lastName, sex, birthDate, birthDateEstimated, city } sans champ sensible', async () => {
      await createPatient(receptionist, newPatient({ lastName: 'Listeur', email: 'liste@example.org', nationalId: 'LISTE123', birthDateEstimated: true }));

      const res = await search(receptionist, { q: 'listeur' }).expect(200);

      expect(Object.keys(res.body.data[0]).sort()).toEqual(['birthDate', 'birthDateEstimated', 'city', 'firstName', 'id', 'ipp', 'lastName', 'sex']);
      expect(res.body.data[0].birthDateEstimated).toBe(true);
    });

    it('refuse avec 422 un terme composé uniquement de jokers SQL', async () => {
      await createPatient(receptionist, newPatient({ lastName: 'Jokertest' }));

      const res = await search(receptionist, { q: '%%' }).expect(422);

      expect(res.body.code).toBe('validation_failed');
    });

    it.each([
      ['q trop court', { q: 'a' }],
      ['q trop long', { q: 'x'.repeat(101) }],
      ['téléphone non E.164', { phone: '0771234567' }],
      ['IPP mal formé', { ipp: 'P26-42' }],
      ['limit hors bornes', { q: 'abc', limit: 101 }],
      ['limit nulle', { q: 'abc', limit: 0 }],
    ])('refuse avec 422 : %s', async (_label, body) => {
      const res = await search(receptionist, body).expect(422);

      expect(res.body.code).toBe('validation_failed');
    });

    it('pagine par curseur sans doublon ni oubli', async () => {
      const prefix = `Pagine${Date.now()}`;
      for (let i = 0; i < 3; i += 1) await createPatient(receptionist, newPatient({ lastName: `${prefix}${i}` }));

      const page1 = await search(receptionist, { q: prefix, limit: 2 }).expect(200);
      const cursor = page1.body.meta.pagination.nextCursor;
      const page2 = await search(receptionist, { q: prefix, limit: 2, cursor }).expect(200);

      expect(page1.body.data).toHaveLength(2);
      expect(page1.body.meta.pagination).toMatchObject({ mode: 'cursor', hasMore: true });
      expect(page2.body.data).toHaveLength(1);
      expect(page2.body.meta.pagination).toMatchObject({ hasMore: false, nextCursor: null });
      expect(new Set([...ids(page1), ...ids(page2)]).size).toBe(3);
    });

    it('refuse avec 422 un curseur invalide (L3)', async () => {
      for (const cursor of ['n-importe-quoi', Buffer.from('pas-un-uuid').toString('base64url')]) {
        const res = await search(receptionist, { q: 'abc', cursor }).expect(422);
        expect(res.body.errors[0].path).toBe('cursor');
      }
    });

    it('ne révèle aucun patient d’un autre tenant', async () => {
      const foreign = await createPatient(otherTenantReceptionist, newPatient({ lastName: 'Etranger' }));

      const res = await search(receptionist, { q: 'etranger' }).expect(200);

      expect(ids(res)).not.toContain(foreign['id']);
    });
  });

  describe('périmètre par site et projection (A6)', () => {
    let siteA: string;
    let siteB: string;
    let patientA: Record<string, any>;
    let patientB: Record<string, any>;
    let patientNoSite: Record<string, any>;
    let siteReceptionist: UserFixture;

    beforeAll(async () => {
      siteA = await createSite(app, a, `PA${Date.now() % 100000}`);
      siteB = await createSite(app, a, `PB${Date.now() % 100000}`);
      patientA = await createPatient(receptionist, newPatient({ primarySiteId: siteA, lastName: 'PerimetreA' }));
      patientB = await createPatient(receptionist, newPatient({ primarySiteId: siteB, lastName: 'PerimetreB' }));
      patientNoSite = await createPatient(receptionist, newPatient({ lastName: 'PerimetreNull' }));
      siteReceptionist = await createUserWithRole(app, a, 'receptionist', { scopeType: 'site', scopeId: siteA });
    });

    it('limite la recherche aux patients du site de la portée et aux patients sans site principal', async () => {
      const res = await search(siteReceptionist, { q: 'perimetre' }).expect(200);

      expect(ids(res).sort()).toEqual([patientA['id'], patientNoSite['id']].sort());
    });

    it('renvoie 404 pour lire, modifier ou supprimer un patient d’un autre site', async () => {
      const url = `/api/v1/patients/${patientB['id']}`;

      await http().get(url).set(auth(siteReceptionist)).expect(404);
      await patchPatient(siteReceptionist, patientB, { city: 'Hors périmètre' }).expect(404);
      await http().get(`/api/v1/patients/${patientA['id']}`).set(auth(siteReceptionist)).expect(200);
      await http().get(`/api/v1/patients/${patientNoSite['id']}`).set(auth(siteReceptionist)).expect(200);
    });

    it('refuse avec 403 site_out_of_scope de créer ou déplacer un patient vers un site hors périmètre', async () => {
      const created = await http().post('/api/v1/patients').set(auth(siteReceptionist)).send(newPatient({ primarySiteId: siteB })).expect(403);
      const moved = await patchPatient(siteReceptionist, patientA, { primarySiteId: siteB }).expect(403);

      expect(created.body.code).toBe('site_out_of_scope');
      expect(moved.body.code).toBe('site_out_of_scope');
      await http().post('/api/v1/patients').set(auth(siteReceptionist)).send(newPatient({ primarySiteId: siteA })).expect(201);
    });

    it('ne laisse pas la détection de doublon divulguer l’identité d’un patient hors périmètre (409 patient_duplicate_out_of_scope, sans détail)', async () => {
      const phone = uniquePhone();
      await createPatient(receptionist, newPatient({ phone, primarySiteId: siteB }));

      const res = await http().post('/api/v1/patients').set(auth(siteReceptionist)).send(newPatient({ phone })).expect(409);

      expect(res.body.code).toBe('patient_duplicate_out_of_scope');
      expect(res.body).not.toHaveProperty('details');
    });

    it('renvoie la projection identité seule (sans coordonnées) à qui ne peut pas modifier un dossier', async () => {
      const full = await createPatient(
        receptionist,
        newPatient({ lastName: 'Projete', email: 'projete@example.org', nationalId: 'PROJ-1', address: '1 rue Cachée', bloodGroup: 'O+', city: 'Dakar' }),
      );

      const adminView = await http().get(`/api/v1/patients/${full['id']}`).set({ Authorization: `Bearer ${a.adminToken}` }).expect(200);
      const writerView = await http().get(`/api/v1/patients/${full['id']}`).set(auth(receptionist)).expect(200);

      expect(adminView.body.data).toMatchObject({ lastName: 'Projete', city: 'Dakar', bloodGroup: 'O+', phone: null, email: null, nationalId: null, address: null });
      const dump = JSON.stringify(adminView.body);
      for (const secret of [full['phone'], 'projete@example.org', 'PROJ-1', '1 rue Cachée']) expect(dump).not.toContain(String(secret));
      expect(writerView.body.data).toMatchObject({ phone: full['phone'], email: 'projete@example.org', nationalId: 'PROJ-1', address: '1 rue Cachée' });
    });
  });

  describe('audit', () => {
    it('trace patient.read avec le patientId à chaque lecture de dossier', async () => {
      const created = await createPatient(receptionist);
      await http().get(`/api/v1/patients/${created['id']}`).set(auth(doctor)).expect(200);
      await http().get(`/api/v1/patients/${created['id']}`).set(auth(doctor)).expect(200);

      const logs = await tenantDb.runAs(a.tenantId, (tx) =>
        tx.auditLog.findMany({ where: { action: 'patient.read', patientId: created['id'] } }),
      );

      expect(logs).toHaveLength(2);
      expect(logs.every((l) => l.actorUserId === doctor.userId && l.outcome === 'success')).toBe(true);
    });

    it('trace patient.searched sans le terme recherché en clair', async () => {
      const phone = uniquePhone();
      await createPatient(receptionist, newPatient({ phone, lastName: 'Confidentiel' }));
      const found = await search(receptionist, { q: 'confidentiel', phone }).expect(200);

      const logs = await tenantDb.runAs(a.tenantId, (tx) =>
        tx.auditLog.findMany({ where: { action: 'patient.searched', actorUserId: receptionist.userId }, orderBy: { chainSeq: 'desc' }, take: 1 }),
      );

      const serialized = JSON.stringify(logs[0]!.changes);
      expect(serialized).not.toContain('confidentiel');
      expect(serialized).not.toContain(phone);
      expect(logs[0]!.changes).toMatchObject({ criteria: ['q', 'phone'], resultCount: 1, patientIds: ids(found) });
    });

    it('consigne dans patient.searched les identifiants des patients renvoyés (patientIds)', async () => {
      const prefix = `Tracee${Date.now()}`;
      const first = await createPatient(receptionist, newPatient({ lastName: `${prefix}A` }));
      const second = await createPatient(receptionist, newPatient({ lastName: `${prefix}B` }));

      await search(receptionist, { q: prefix }).expect(200);

      const log = await tenantDb.runAs(a.tenantId, (tx) =>
        tx.auditLog.findFirstOrThrow({ where: { action: 'patient.searched', actorUserId: receptionist.userId }, orderBy: { chainSeq: 'desc' } }),
      );
      expect((log.changes as { patientIds: string[] }).patientIds.sort()).toEqual([first['id'], second['id']].sort());
      expect(JSON.stringify(log.changes)).not.toContain(prefix.toLowerCase());
    });

    it('trace patient.created sans valeur clinique', async () => {
      const body = newPatient({ lastName: 'Auditee', nationalId: 'AUDIT-NID-1' });
      const created = await createPatient(receptionist, body);

      const log = await tenantDb.runAs(a.tenantId, (tx) =>
        tx.auditLog.findFirstOrThrow({ where: { action: 'patient.created', resourceId: created['id'] } }),
      );

      const serialized = JSON.stringify(log.changes);
      expect(serialized).toContain('nationalId');
      expect(serialized).not.toContain('AUDIT-NID-1');
      expect(serialized).not.toContain('Auditee');
    });
  });

  describe('autorisations et isolation', () => {
    it('refuse avec 403 un rôle sans permission patients (stock_manager)', async () => {
      await search(stockManager, { q: 'abc' }).expect(403);
      const res = await http().post('/api/v1/patients').set(auth(stockManager)).send(newPatient()).expect(403);

      expect(res.body.code).toBe('permission_denied');
    });

    it('autorise la lecture mais refuse la création au comptable', async () => {
      const created = await createPatient(receptionist);

      await http().get(`/api/v1/patients/${created['id']}`).set(auth(accountant)).expect(200);
      await http().post('/api/v1/patients').set(auth(accountant)).send(newPatient()).expect(403);
    });

    it('refuse avec 401 sans jeton', async () => {
      await http().post('/api/v1/patients/search').send({ q: 'abc' }).expect(401);
    });

    it('renvoie 404 pour un patient d’un autre tenant (lecture, modification, suppression)', async () => {
      const foreign = await createPatient(otherTenantReceptionist);
      const url = `/api/v1/patients/${foreign['id']}`;

      await http().get(url).set(auth(receptionist)).expect(404);
      await http().patch(url).set(auth(receptionist)).set('If-Match', '"1"').send({ city: 'Piraterie' }).expect(404);
      await http().delete(url).set(auth(manager)).set('If-Match', '"1"').send({ reason: 'Intrusion' }).expect(404);
    });

    it('renvoie 404 pour un identifiant mal formé ou inconnu', async () => {
      await http().get('/api/v1/patients/pas-un-uuid').set(auth(receptionist)).expect(404);
      await http().get('/api/v1/patients/018f0000-0000-7000-8000-000000000000').set(auth(receptionist)).expect(404);
    });

    it('ignore un tenantId fourni par le client dans le corps', async () => {
      const created = await createPatient(receptionist, newPatient({ tenantId: b.tenantId }));

      const stored = await tenantDb.runAs(a.tenantId, (tx) => tx.patient.findFirst({ where: { id: created['id'] } }));

      expect(stored?.tenantId).toBe(a.tenantId);
    });
  });

  describe('validation (422)', () => {
    it.each([
      ['nom manquant', { firstName: 'Seul' }],
      ['téléphone non E.164', { lastName: 'X', firstName: 'Y', phone: '0771234567' }],
      ['email invalide', { lastName: 'X', firstName: 'Y', email: 'pas-un-email' }],
      ['date de naissance invalide', { lastName: 'X', firstName: 'Y', birthDate: '31/12/1990' }],
      ['groupe sanguin inconnu', { lastName: 'X', firstName: 'Y', bloodGroup: 'Z+' }],
      ['date de naissance future', { lastName: 'X', firstName: 'Y', birthDate: '2999-01-01' }],
      ['âge supérieur à 130 ans', { lastName: 'X', firstName: 'Y', birthDate: '1850-01-01' }],
      ['date estimée sans date de naissance', { lastName: 'X', firstName: 'Y', birthDateEstimated: true }],
    ])('refuse avec 422 : %s', async (_label, body) => {
      const res = await http().post('/api/v1/patients').set(auth(receptionist)).send(body).expect(422);

      expect(res.body.code).toBe('validation_failed');
    });

    it('refuse avec 422 un site principal inexistant', async () => {
      const res = await http()
        .post('/api/v1/patients')
        .set(auth(receptionist))
        .send(newPatient({ primarySiteId: '018f0000-0000-7000-8000-000000000000' }))
        .expect(422);

      expect(res.body.errors[0].path).toBe('primarySiteId');
    });

    it('refuse avec 422 un site d’un autre tenant', async () => {
      await http().post('/api/v1/patients').set(auth(receptionist)).send(newPatient({ primarySiteId: b.mainSiteId })).expect(422);
    });

    it('accepte les caractères spéciaux, emojis et apostrophes dans les noms', async () => {
      const created = await createPatient(receptionist, newPatient({ lastName: 'O\'Brien-Çelik', firstName: 'Zoë 😀', phone: undefined, birthDate: '2001-02-03' }));

      expect(created['lastName']).toBe('O\'Brien-Çelik');
    });

    it('refuse avec 422 un paramètre force invalide', async () => {
      await http().post('/api/v1/patients?force=peut-etre').set(auth(receptionist)).send(newPatient()).expect(422);
    });
  });

  describe('modification (PATCH)', () => {
    it('modifie les champs, chiffre le nouveau téléphone et incrémente la version', async () => {
      const created = await createPatient(receptionist);
      const newPhone = uniquePhone();

      const res = await patchPatient(receptionist, created, { phone: newPhone, city: 'Thiès' }).expect(200);
      const found = await search(receptionist, { phone: newPhone }).expect(200);

      expect(res.body.data).toMatchObject({ phone: newPhone, city: 'Thiès', rowVersion: created['rowVersion'] + 1 });
      expect(res.headers['etag']).toBe(`"${created['rowVersion'] + 1}"`);
      expect(ids(found)).toEqual([created['id']]);
    });

    it('ne réinitialise pas les champs absents de la requête (sexe, date estimée)', async () => {
      const created = await createPatient(receptionist, newPatient({ sex: 'male', birthDateEstimated: true }));

      const res = await patchPatient(receptionist, created, { city: 'Kaolack' }).expect(200);

      expect(res.body.data).toMatchObject({ sex: 'male', birthDateEstimated: true, city: 'Kaolack' });
    });

    it('remet birthDateEstimated à false quand birthDate change sans l’indicateur (A9)', async () => {
      const created = await createPatient(receptionist, newPatient({ birthDate: '1990-01-01', birthDateEstimated: true }));

      const res = await patchPatient(receptionist, created, { birthDate: '1991-02-02' }).expect(200);
      const kept = await patchPatient(receptionist, res.body.data, { birthDate: '1992-03-03', birthDateEstimated: true }).expect(200);

      expect(res.body.data).toMatchObject({ birthDate: '1991-02-02', birthDateEstimated: false });
      expect(kept.body.data).toMatchObject({ birthDate: '1992-03-03', birthDateEstimated: true });
    });

    it('refuse avec 422 d’estimer une date de naissance inexistante, et une date future', async () => {
      const created = await createPatient(receptionist, { lastName: 'SansDate', firstName: 'Awa', phone: uniquePhone() });

      const noDate = await patchPatient(receptionist, created, { birthDateEstimated: true }).expect(422);
      await patchPatient(receptionist, created, { birthDate: '2999-01-01' }).expect(422);

      expect(noDate.body.errors[0].path).toBe('birthDateEstimated');
    });

    it('efface téléphone, e-mail, pièce, adresse, ville et groupe sanguin avec null (A9)', async () => {
      const phone = uniquePhone();
      const created = await createPatient(
        receptionist,
        newPatient({ phone, email: 'efface@example.org', nationalId: 'EFFACE-1', address: 'Rue X', city: 'Dakar', bloodGroup: 'A+' }),
      );

      const res = await patchPatient(receptionist, created, { phone: null, email: null, nationalId: null, address: null, city: null, bloodGroup: null }).expect(200);
      const found = await search(receptionist, { phone }).expect(200);

      expect(res.body.data).toMatchObject({ phone: null, email: null, nationalId: null, address: null, city: null, bloodGroup: null });
      expect(ids(found)).not.toContain(created['id']);
      const stored = await tenantDb.runAs(a.tenantId, (tx) => tx.patient.findFirstOrThrow({ where: { id: created['id'] } }));
      expect([stored.phoneEnc, stored.phoneBidx, stored.emailEnc, stored.emailBidx, stored.nationalIdEnc, stored.nationalIdBidx, stored.addressEnc]).toEqual(Array(7).fill(null));
    });

    it('refuse null pour les champs d’identité obligatoires (422)', async () => {
      const created = await createPatient(receptionist);

      await patchPatient(receptionist, created, { lastName: null }).expect(422);
      await patchPatient(receptionist, created, { birthDate: null }).expect(422);
    });

    it('recalcule le nom de recherche quand le nom change', async () => {
      const created = await createPatient(receptionist, newPatient({ lastName: 'Ancien' }));
      await patchPatient(receptionist, created, { lastName: 'Nouvéau' }).expect(200);

      const res = await search(receptionist, { q: 'nouveau' }).expect(200);

      expect(ids(res)).toContain(created['id']);
    });

    it('refuse avec 412 une version périmée (If-Match)', async () => {
      const created = await createPatient(receptionist);
      await patchPatient(receptionist, created, { city: 'Première' }).expect(200);

      const res = await patchPatient(receptionist, created, { city: 'Obsolète' }).expect(412);

      expect(res.body.code).toBe('precondition_failed');
    });

    it('refuse avec 428 precondition_required une modification sans If-Match', async () => {
      const created = await createPatient(receptionist);

      const res = await http().patch(`/api/v1/patients/${created['id']}`).set(auth(receptionist)).send({ city: 'Sans version' }).expect(428);

      expect(res.body.code).toBe('precondition_required');
    });

    it('refuse avec 422 un en-tête If-Match illisible', async () => {
      const created = await createPatient(receptionist);

      await http().patch(`/api/v1/patients/${created['id']}`).set(auth(receptionist)).set('If-Match', 'abc').send({ city: 'X' }).expect(422);
    });

    it('refuse avec 422 un corps vide', async () => {
      const created = await createPatient(receptionist);

      await patchPatient(receptionist, created, {}).expect(422);
    });

    it('audite la liste des champs modifiés sans leurs valeurs', async () => {
      const created = await createPatient(receptionist);
      await patchPatient(receptionist, created, { nationalId: 'NOUVEAU-NID-42', city: 'Louga' }).expect(200);

      const log = await tenantDb.runAs(a.tenantId, (tx) =>
        tx.auditLog.findFirstOrThrow({ where: { action: 'patient.updated', resourceId: created['id'] } }),
      );

      expect(log.changes).toEqual({ fields: ['nationalId', 'city'] });
      expect(JSON.stringify(log.changes)).not.toContain('NOUVEAU-NID-42');
    });

    it('refuse avec 403 la modification à un rôle en lecture seule', async () => {
      const created = await createPatient(receptionist);

      await patchPatient(accountant, created, { city: 'Non' }).expect(403);
    });
  });

  describe('suppression logique', () => {
    const remove = (user: UserFixture, patient: Record<string, any>, body: Record<string, unknown> = { reason: 'Doublon avéré' }) =>
      http().delete(`/api/v1/patients/${patient['id']}`).set(auth(user)).set('If-Match', `"${patient['rowVersion']}"`).send(body);

    it('refuse avec 403 sans la permission patients:patient:delete', async () => {
      const created = await createPatient(receptionist);

      await remove(receptionist, created).expect(403);
    });

    it('exige If-Match (428) et un motif de 3 à 500 caractères (422)', async () => {
      const created = await createPatient(receptionist);

      const noHeader = await http().delete(`/api/v1/patients/${created['id']}`).set(auth(manager)).send({ reason: 'Doublon avéré' }).expect(428);
      await remove(manager, created, {}).expect(422);
      await remove(manager, created, { reason: 'ab' }).expect(422);
      await remove(manager, created, { reason: 'x'.repeat(501) }).expect(422);

      expect(noHeader.body.code).toBe('precondition_required');
      await http().get(`/api/v1/patients/${created['id']}`).set(auth(receptionist)).expect(200);
    });

    it('refuse avec 412 une suppression sur une version périmée', async () => {
      const created = await createPatient(receptionist);
      await patchPatient(receptionist, created, { city: 'Modifié' }).expect(200);

      const res = await remove(manager, created).expect(412);

      expect(res.body.code).toBe('precondition_failed');
      await http().get(`/api/v1/patients/${created['id']}`).set(auth(receptionist)).expect(200);
    });

    it('supprime logiquement : 204, puis 404 en lecture et absence de la recherche, ligne conservée, motif audité', async () => {
      const created = await createPatient(receptionist, newPatient({ lastName: 'Supprimable' }));

      await remove(manager, created, { reason: 'Saisie par erreur' }).expect(204);
      await http().get(`/api/v1/patients/${created['id']}`).set(auth(receptionist)).expect(404);
      const found = await search(receptionist, { q: 'supprimable' }).expect(200);
      const stored = await tenantDb.runAs(a.tenantId, (tx) => tx.patient.findFirst({ where: { id: created['id'] } }));
      const log = await tenantDb.runAs(a.tenantId, (tx) => tx.auditLog.findFirstOrThrow({ where: { action: 'patient.deleted', resourceId: created['id'] } }));

      expect(found.body.data).toEqual([]);
      expect(stored?.deletedAt).toBeInstanceOf(Date);
      expect(log.changes).toEqual({ reason: 'Saisie par erreur', cancelledAppointmentIds: [] });
    });

    it('renvoie 404 à la seconde suppression', async () => {
      const created = await createPatient(receptionist);
      await remove(manager, created).expect(204);

      await remove(manager, created).expect(404);
    });
  });
});
