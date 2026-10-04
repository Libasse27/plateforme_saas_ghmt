import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTenantFixture, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { auditEntries, bearer, createSite, createUserWithCustomPermissions } from '../iam/support';

const BASE = '/api/v1/org';
const UNKNOWN_ID = '0198a000-0000-7000-8000-0000000000ff';

describe('org : sites et services (HTTP)', () => {
  let app: INestApplication;
  let a: TenantFixture;
  let b: TenantFixture;
  let receptionist: UserFixture;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
    [a, b] = await Promise.all([createTenantFixture(app, { prefix: 'org-a' }), createTenantFixture(app, { prefix: 'org-b' })]);
    receptionist = await createUserWithRole(app, a, 'receptionist');
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('sites', () => {
    it('crée un site (201), le renvoie sans champ interne et audite la création', async () => {
      const res = await http().post(`${BASE}/sites`).set(bearer(a.adminToken)).send({ code: 'NORD', name: 'Site Nord', city: 'Thiès' }).expect(201);

      expect(res.body.data).toMatchObject({ code: 'NORD', name: 'Site Nord', city: 'Thiès', isMain: false });
      expect(res.body.data).not.toHaveProperty('tenantId');
      const audit = await auditEntries(app, a.tenantId, 'org.site.created');
      expect(audit.some((e) => e.resourceId === res.body.data.id)).toBe(true);
    });

    it('refuse un code de site déjà utilisé (409 site_code_conflict)', async () => {
      await http().post(`${BASE}/sites`).set(bearer(a.adminToken)).send({ code: 'DUP', name: 'Premier' }).expect(201);

      const res = await http().post(`${BASE}/sites`).set(bearer(a.adminToken)).send({ code: 'DUP', name: 'Second' }).expect(409);

      expect(res.body.code).toBe('site_code_conflict');
    });

    it('rejette un corps invalide (422 validation_failed)', async () => {
      const res = await http().post(`${BASE}/sites`).set(bearer(a.adminToken)).send({ code: '', name: 'x' }).expect(422);

      expect(res.body.code).toBe('validation_failed');
      expect(res.body.errors.length).toBeGreaterThan(0);
    });

    it('liste les sites de l’établissement, site principal en tête', async () => {
      const res = await http().get(`${BASE}/sites`).set(bearer(a.adminToken)).expect(200);

      expect(res.body.data[0]).toMatchObject({ id: a.mainSiteId, isMain: true });
    });

    it('modifie un site et audite avant/après', async () => {
      const id = await createSite(app, a, 'MOD');

      const res = await http().patch(`${BASE}/sites/${id}`).set(bearer(a.adminToken)).send({ name: 'Nouveau nom' }).expect(200);

      expect(res.body.data.name).toBe('Nouveau nom');
      const entry = (await auditEntries(app, a.tenantId, 'org.site.updated')).find((e) => e.resourceId === id);
      expect(entry?.changes).toEqual({ before: { name: 'Site MOD' }, after: { name: 'Nouveau nom' } });
    });

    it('refuse de renommer le code vers un code existant (409)', async () => {
      const id = await createSite(app, a, 'CONF1');
      await createSite(app, a, 'CONF2');

      await http().patch(`${BASE}/sites/${id}`).set(bearer(a.adminToken)).send({ code: 'CONF2' }).expect(409);
    });

    it('accepte de conserver son propre code lors d’une modification', async () => {
      const id = await createSite(app, a, 'SAME');

      await http().patch(`${BASE}/sites/${id}`).set(bearer(a.adminToken)).send({ code: 'SAME', city: 'Saint-Louis' }).expect(200);
    });

    it('supprime logiquement un site puis répond 404', async () => {
      const id = await createSite(app, a, 'DEL');

      await http().delete(`${BASE}/sites/${id}`).set(bearer(a.adminToken)).expect(204);

      await http().get(`${BASE}/sites/${id}`).set(bearer(a.adminToken)).expect(404);
      const list = await http().get(`${BASE}/sites`).set(bearer(a.adminToken)).expect(200);
      expect(list.body.data.some((s: { id: string }) => s.id === id)).toBe(false);
      expect((await auditEntries(app, a.tenantId, 'org.site.deleted')).some((e) => e.resourceId === id)).toBe(true);
    });

    it('refuse de supprimer le site principal (409 main_site)', async () => {
      const res = await http().delete(`${BASE}/sites/${a.mainSiteId}`).set(bearer(a.adminToken)).expect(409);

      expect(res.body.code).toBe('main_site');
    });

    it('refuse de supprimer un site ayant des services actifs (409 site_has_departments)', async () => {
      const siteId = await createSite(app, a, 'AVECSVC');
      await http().post(`${BASE}/departments`).set(bearer(a.adminToken)).send({ siteId, code: 'URG', name: 'Urgences' }).expect(201);

      const res = await http().delete(`${BASE}/sites/${siteId}`).set(bearer(a.adminToken)).expect(409);

      expect(res.body.code).toBe('site_has_departments');
    });

    it('refuse les écritures à un rôle sans permission (403)', async () => {
      await http().post(`${BASE}/sites`).set(bearer(receptionist.token)).send({ code: 'X1', name: 'Interdit' }).expect(403);
      await http().patch(`${BASE}/sites/${a.mainSiteId}`).set(bearer(receptionist.token)).send({ name: 'Piraté' }).expect(403);
      await http().delete(`${BASE}/sites/${a.mainSiteId}`).set(bearer(receptionist.token)).expect(403);
    });

    it('exige une authentification (401)', async () => {
      await http().get(`${BASE}/sites`).expect(401);
    });

    it('répond 404 pour un site d’un autre établissement (lecture, modification, suppression)', async () => {
      await http().get(`${BASE}/sites/${b.mainSiteId}`).set(bearer(a.adminToken)).expect(404);
      await http().patch(`${BASE}/sites/${b.mainSiteId}`).set(bearer(a.adminToken)).send({ name: 'Intrusion' }).expect(404);
      await http().delete(`${BASE}/sites/${b.mainSiteId}`).set(bearer(a.adminToken)).expect(404);
    });

    it('répond 404 pour un identifiant mal formé ou inconnu', async () => {
      await http().get(`${BASE}/sites/pas-un-uuid`).set(bearer(a.adminToken)).expect(404);
      await http().get(`${BASE}/sites/${UNKNOWN_ID}`).set(bearer(a.adminToken)).expect(404);
    });

    it('ne liste, pour un utilisateur limité à un site, que ce site', async () => {
      const siteId = await createSite(app, a, 'SCOPE');
      const scoped = await createUserWithRole(app, a, 'receptionist', { scopeType: 'site', scopeId: siteId });

      const list = await http().get(`${BASE}/sites`).set(bearer(scoped.token)).expect(200);

      expect(list.body.data.map((s: { id: string }) => s.id)).toEqual([siteId]);
      await http().get(`${BASE}/sites/${siteId}`).set(bearer(scoped.token)).expect(200);
      await http().get(`${BASE}/sites/${a.mainSiteId}`).set(bearer(scoped.token)).expect(404);
    });

    it('limite les écritures aux sites de la portée (403 out_of_scope) et réserve la création à l’établissement', async () => {
      const siteB = await createSite(app, a, 'GEST-B');
      const siteC = await createSite(app, a, 'GEST-C');
      const manager = await createUserWithCustomPermissions(
        app,
        a,
        ['org:site:read', 'org:site:create', 'org:site:update', 'org:site:delete'],
        { scopeType: 'site', scopeId: siteB },
      );

      await http().patch(`${BASE}/sites/${siteB}`).set(bearer(manager.token)).send({ city: 'Ziguinchor' }).expect(200);
      const outside = await http().patch(`${BASE}/sites/${siteC}`).set(bearer(manager.token)).send({ city: 'Kaolack' }).expect(403);
      expect(outside.body.code).toBe('out_of_scope');
      await http().delete(`${BASE}/sites/${siteC}`).set(bearer(manager.token)).expect(403);
      await http().post(`${BASE}/sites`).set(bearer(manager.token)).send({ code: 'NEW', name: 'Nouveau' }).expect(403);
    });
  });

  describe('services (departments)', () => {
    let siteId: string;
    let otherSiteId: string;

    beforeAll(async () => {
      siteId = await createSite(app, a, 'DEP-S1');
      otherSiteId = await createSite(app, a, 'DEP-S2');
    });

    const createDepartment = async (body: Record<string, unknown>) =>
      http().post(`${BASE}/departments`).set(bearer(a.adminToken)).send(body);

    it('crée un service (201, kind par défaut clinical) et audite', async () => {
      const res = await createDepartment({ siteId, code: 'MAT', name: 'Maternité' }).then((r) => {
        expect(r.status).toBe(201);
        return r;
      });

      expect(res.body.data).toMatchObject({ siteId, code: 'MAT', kind: 'clinical', parentId: null });
      expect((await auditEntries(app, a.tenantId, 'org.department.created')).some((e) => e.resourceId === res.body.data.id)).toBe(true);
    });

    it('refuse un code déjà utilisé sur le même site (409) mais l’accepte sur un autre site', async () => {
      await createDepartment({ siteId, code: 'LAB', name: 'Laboratoire' }).then((r) => expect(r.status).toBe(201));

      const conflict = await createDepartment({ siteId, code: 'LAB', name: 'Autre' });
      const other = await createDepartment({ siteId: otherSiteId, code: 'LAB', name: 'Labo 2' });

      expect(conflict.status).toBe(409);
      expect(conflict.body.code).toBe('department_code_conflict');
      expect(other.status).toBe(201);
    });

    it('rejette un corps invalide (422) et un site inconnu (422 site_not_found)', async () => {
      const invalid = await createDepartment({ siteId: 'x', code: '', name: '' });
      const unknownSite = await createDepartment({ siteId: UNKNOWN_ID, code: 'ZZ', name: 'Service ZZ' });

      expect(invalid.status).toBe(422);
      expect(unknownSite.status).toBe(422);
      expect(unknownSite.body.code).toBe('site_not_found');
    });

    it('refuse un site d’un autre établissement (422, sans révéler son existence)', async () => {
      const res = await createDepartment({ siteId: b.mainSiteId, code: 'INT', name: 'Intrusion' });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('site_not_found');
    });

    it('accepte un parent du même site et refuse un parent d’un autre site (422 invalid_parent)', async () => {
      const parent = await createDepartment({ siteId, code: 'PAR', name: 'Parent' });

      const child = await createDepartment({ siteId, code: 'ENF', name: 'Enfant', parentId: parent.body.data.id });
      const wrong = await createDepartment({ siteId: otherSiteId, code: 'ENF2', name: 'Enfant', parentId: parent.body.data.id });
      const missing = await createDepartment({ siteId, code: 'ENF3', name: 'Enfant', parentId: UNKNOWN_ID });

      expect(child.status).toBe(201);
      expect(child.body.data.parentId).toBe(parent.body.data.id);
      expect(wrong.status).toBe(422);
      expect(wrong.body.code).toBe('invalid_parent');
      expect(missing.status).toBe(422);
    });

    it('refuse à la modification un parent identique à soi-même ou créant une boucle', async () => {
      const root = (await createDepartment({ siteId, code: 'R1', name: 'Racine' })).body.data.id as string;
      const leaf = (await createDepartment({ siteId, code: 'R2', name: 'Feuille', parentId: root })).body.data.id as string;

      const self = await http().patch(`${BASE}/departments/${root}`).set(bearer(a.adminToken)).send({ parentId: root });
      const loop = await http().patch(`${BASE}/departments/${root}`).set(bearer(a.adminToken)).send({ parentId: leaf });

      expect(self.status).toBe(422);
      expect(loop.status).toBe(422);
      expect(loop.body.code).toBe('invalid_parent');
    });

    it('modifie un service et audite avant/après', async () => {
      const id = (await createDepartment({ siteId, code: 'UPD', name: 'Avant' })).body.data.id as string;

      const res = await http().patch(`${BASE}/departments/${id}`).set(bearer(a.adminToken)).send({ name: 'Après', kind: 'support' }).expect(200);

      expect(res.body.data).toMatchObject({ name: 'Après', kind: 'support' });
      const entry = (await auditEntries(app, a.tenantId, 'org.department.updated')).find((e) => e.resourceId === id);
      expect(entry?.changes).toEqual({ before: { name: 'Avant', kind: 'clinical' }, after: { name: 'Après', kind: 'support' } });
    });

    it('refuse de renommer le code vers un code existant du site (409)', async () => {
      await createDepartment({ siteId, code: 'C1', name: 'Un' });
      const id = (await createDepartment({ siteId, code: 'C2', name: 'Deux' })).body.data.id as string;

      await http().patch(`${BASE}/departments/${id}`).set(bearer(a.adminToken)).send({ code: 'C1' }).expect(409);
    });

    it('filtre la liste par siteId', async () => {
      const res = await http().get(`${BASE}/departments`).query({ siteId: otherSiteId }).set(bearer(a.adminToken)).expect(200);

      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data.every((d: { siteId: string }) => d.siteId === otherSiteId)).toBe(true);
    });

    it('rejette un filtre siteId invalide (422)', async () => {
      await http().get(`${BASE}/departments`).query({ siteId: 'nope' }).set(bearer(a.adminToken)).expect(422);
    });

    it('supprime logiquement un service, refuse s’il a des sous-services (409)', async () => {
      const parent = (await createDepartment({ siteId, code: 'P-DEL', name: 'Parent' })).body.data.id as string;
      const child = (await createDepartment({ siteId, code: 'E-DEL', name: 'Enfant', parentId: parent })).body.data.id as string;

      const blocked = await http().delete(`${BASE}/departments/${parent}`).set(bearer(a.adminToken)).expect(409);
      await http().delete(`${BASE}/departments/${child}`).set(bearer(a.adminToken)).expect(204);
      await http().delete(`${BASE}/departments/${parent}`).set(bearer(a.adminToken)).expect(204);

      expect(blocked.body.code).toBe('department_has_children');
      await http().get(`${BASE}/departments/${parent}`).set(bearer(a.adminToken)).expect(404);
      expect((await auditEntries(app, a.tenantId, 'org.department.deleted')).some((e) => e.resourceId === parent)).toBe(true);
    });

    it('refuse les écritures à un rôle sans permission (403)', async () => {
      await http().post(`${BASE}/departments`).set(bearer(receptionist.token)).send({ siteId, code: 'NOPE', name: 'Interdit' }).expect(403);
    });

    it('répond 404 pour un service d’un autre établissement', async () => {
      const foreign = (await request(app.getHttpServer())
        .post(`${BASE}/departments`)
        .set(bearer(b.adminToken))
        .send({ siteId: b.mainSiteId, code: 'B-SVC', name: 'Service B' })
        .expect(201)).body.data.id as string;

      await http().get(`${BASE}/departments/${foreign}`).set(bearer(a.adminToken)).expect(404);
      await http().patch(`${BASE}/departments/${foreign}`).set(bearer(a.adminToken)).send({ name: 'X1' }).expect(404);
      await http().delete(`${BASE}/departments/${foreign}`).set(bearer(a.adminToken)).expect(404);
      const list = await http().get(`${BASE}/departments`).set(bearer(a.adminToken)).expect(200);
      expect(list.body.data.some((d: { id: string }) => d.id === foreign)).toBe(false);
    });

    it('filtre par portée : un utilisateur limité à un site ne voit que les services de ce site', async () => {
      const scopeSite = await createSite(app, a, 'DEP-SC');
      const own = (await createDepartment({ siteId: scopeSite, code: 'OWN', name: 'Mon service' })).body.data.id as string;
      const foreign = (await createDepartment({ siteId, code: 'FOREIGN', name: 'Autre site' })).body.data.id as string;
      const scoped = await createUserWithRole(app, a, 'doctor', { scopeType: 'site', scopeId: scopeSite });

      const list = await http().get(`${BASE}/departments`).set(bearer(scoped.token)).expect(200);

      expect(list.body.data.map((d: { id: string }) => d.id)).toEqual([own]);
      await http().get(`${BASE}/departments/${own}`).set(bearer(scoped.token)).expect(200);
      await http().get(`${BASE}/departments/${foreign}`).set(bearer(scoped.token)).expect(404);
    });

    it('limite les écritures aux sites de la portée (403 out_of_scope)', async () => {
      const mySite = await createSite(app, a, 'DEP-W1');
      const otherSite = await createSite(app, a, 'DEP-W2');
      const foreignDept = (await createDepartment({ siteId: otherSite, code: 'W2', name: 'Hors portée' })).body.data.id as string;
      const manager = await createUserWithCustomPermissions(
        app,
        a,
        ['org:service:read', 'org:service:create', 'org:service:update', 'org:service:delete'],
        { scopeType: 'site', scopeId: mySite },
      );

      const inside = await http().post(`${BASE}/departments`).set(bearer(manager.token)).send({ siteId: mySite, code: 'IN', name: 'Dans la portée' });
      const outside = await http().post(`${BASE}/departments`).set(bearer(manager.token)).send({ siteId: otherSite, code: 'OUT', name: 'Hors portée' });
      const patchOutside = await http().patch(`${BASE}/departments/${foreignDept}`).set(bearer(manager.token)).send({ name: 'Piraté' });

      expect(inside.status).toBe(201);
      expect(outside.status).toBe(403);
      expect(outside.body.code).toBe('out_of_scope');
      expect(patchOutside.status).toBe(403);
    });
  });
});
