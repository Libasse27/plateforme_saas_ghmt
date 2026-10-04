import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTenantFixture, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { auditEntries, bearer, createCustomRole, createUserWithCustomPermissions, roleIdByCode } from './support';

const BASE = '/api/v1/iam';
const UNKNOWN_ID = '0198a000-0000-7000-8000-0000000000ff';

describe('iam : rôles et catalogue de permissions (HTTP)', () => {
  let app: INestApplication;
  let a: TenantFixture;
  let b: TenantFixture;
  let receptionist: UserFixture;
  const http = () => request(app.getHttpServer());
  const postRole = (body: Record<string, unknown>, token = a.adminToken) => http().post(`${BASE}/roles`).set(bearer(token)).send(body);

  beforeAll(async () => {
    app = await createTestApp();
    [a, b] = await Promise.all([createTenantFixture(app, { prefix: 'role-a' }), createTenantFixture(app, { prefix: 'role-b' })]);
    receptionist = await createUserWithRole(app, a, 'receptionist');
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('lecture', () => {
    it('liste les 13 rôles système avec leur nombre de permissions', async () => {
      const res = await http().get(`${BASE}/roles`).set(bearer(a.adminToken)).expect(200);

      const system = res.body.data.filter((r: { isSystem: boolean }) => r.isSystem);
      expect(system).toHaveLength(13);
      expect(res.body.data.find((r: { code: string }) => r.code === 'tenant_admin').permissionCount).toBeGreaterThan(20);
    });

    it('renvoie le détail d’un rôle avec la liste de ses permissions', async () => {
      const id = await roleIdByCode(app, a, 'hr_manager');

      const res = await http().get(`${BASE}/roles/${id}`).set(bearer(a.adminToken)).expect(200);

      expect(res.body.data).toMatchObject({ code: 'hr_manager', isSystem: true });
      expect(res.body.data.permissions).toContain('iam:user:read');
    });

    it('refuse la lecture sans permission iam:role:read (403)', async () => {
      await http().get(`${BASE}/roles`).set(bearer(receptionist.token)).expect(403);
      await http().get(`${BASE}/permissions`).set(bearer(receptionist.token)).expect(403);
    });

    it('répond 404 pour un rôle inconnu, mal formé ou d’un autre établissement', async () => {
      const foreignId = await roleIdByCode(app, b, 'doctor');

      await http().get(`${BASE}/roles/${UNKNOWN_ID}`).set(bearer(a.adminToken)).expect(404);
      await http().get(`${BASE}/roles/zzz`).set(bearer(a.adminToken)).expect(404);
      await http().get(`${BASE}/roles/${foreignId}`).set(bearer(a.adminToken)).expect(404);
      await http().patch(`${BASE}/roles/${foreignId}`).set(bearer(a.adminToken)).send({ name: 'Intrusion' }).expect(404);
      await http().delete(`${BASE}/roles/${foreignId}`).set(bearer(a.adminToken)).expect(404);
    });

    it('expose le catalogue de permissions groupé par module', async () => {
      const res = await http().get(`${BASE}/permissions`).set(bearer(a.adminToken)).expect(200);

      const iam = res.body.data.find((g: { module: string }) => g.module === 'iam');
      expect(iam.name).toBeTruthy();
      expect(iam.permissions).toContainEqual(expect.objectContaining({ code: 'iam:user:read', resource: 'user', action: 'read' }));
      expect(res.body.data.map((g: { module: string }) => g.module)).toEqual(expect.arrayContaining(['org', 'patients', 'billing']));
    });
  });

  describe('création', () => {
    it('crée un rôle personnalisé (201), dédoublonne les permissions et audite', async () => {
      const res = await postRole({
        code: 'agent_accueil',
        name: 'Agent d’accueil',
        description: 'Accueil des visiteurs',
        permissions: ['org:site:read', 'iam:user:read', 'org:site:read'],
      }).expect(201);

      expect(res.body.data).toMatchObject({ code: 'agent_accueil', isSystem: false, description: 'Accueil des visiteurs' });
      expect(res.body.data.permissions).toEqual(['iam:user:read', 'org:site:read']);
      const entry = (await auditEntries(app, a.tenantId, 'iam.role.created')).find((e) => e.resourceId === res.body.data.id);
      expect(entry?.changes).toMatchObject({ after: { code: 'agent_accueil', permissions: ['org:site:read', 'iam:user:read'] } });
    });

    it('refuse un code déjà utilisé, y compris celui d’un rôle système (409)', async () => {
      await postRole({ code: 'doublon', name: 'Doublon', permissions: [] }).expect(201);

      const custom = await postRole({ code: 'doublon', name: 'Autre', permissions: [] }).expect(409);
      const system = await postRole({ code: 'doctor', name: 'Autre', permissions: [] }).expect(409);

      expect(custom.body.code).toBe('role_code_conflict');
      expect(system.body.code).toBe('role_code_conflict');
    });

    it.each([
      ['permission hors catalogue', { code: 'role_x', name: 'Role X', permissions: ['iam:user:fly'] }],
      ['joker interdit', { code: 'role_x', name: 'Role X', permissions: ['iam:*:*'] }],
      ['code invalide', { code: 'Code Invalide', name: 'Role X', permissions: [] }],
      ['nom manquant', { code: 'role_x', permissions: [] }],
      ['permissions absentes', { code: 'role_x', name: 'Role X' }],
    ])('rejette un corps invalide : %s (422)', async (_label, body) => {
      const res = await postRole(body).expect(422);

      expect(res.body.code).toBe('validation_failed');
    });

    it('refuse la création à un rôle sans permission (403)', async () => {
      await postRole({ code: 'role_y', name: 'Role Y', permissions: [] }, receptionist.token).expect(403);
    });
  });

  describe('modification et suppression', () => {
    it('modifie nom, description et permissions et audite avant/après', async () => {
      const role = await createCustomRole(app, a, ['iam:user:read'], 'a_modifier');

      const res = await http()
        .patch(`${BASE}/roles/${role.id}`)
        .set(bearer(a.adminToken))
        .send({ name: 'Rôle modifié', description: 'Nouvelle description', permissions: ['org:site:read', 'org:service:read'] })
        .expect(200);

      expect(res.body.data).toMatchObject({ name: 'Rôle modifié', description: 'Nouvelle description' });
      expect(res.body.data.permissions).toEqual(['org:service:read', 'org:site:read']);
      const entry = (await auditEntries(app, a.tenantId, 'iam.role.updated')).find((e) => e.resourceId === role.id);
      expect(entry?.changes).toMatchObject({
        before: { permissions: ['iam:user:read'] },
        after: { name: 'Rôle modifié', permissions: ['org:site:read', 'org:service:read'] },
      });
    });

    it('conserve les permissions quand seul le nom change', async () => {
      const role = await createCustomRole(app, a, ['iam:user:read']);

      const res = await http().patch(`${BASE}/roles/${role.id}`).set(bearer(a.adminToken)).send({ name: 'Juste le nom' }).expect(200);

      expect(res.body.data.permissions).toEqual(['iam:user:read']);
    });

    it('rejette une modification vide ou avec permission inconnue (422)', async () => {
      const role = await createCustomRole(app, a, []);

      await http().patch(`${BASE}/roles/${role.id}`).set(bearer(a.adminToken)).send({}).expect(422);
      await http().patch(`${BASE}/roles/${role.id}`).set(bearer(a.adminToken)).send({ permissions: ['x:y:z'] }).expect(422);
    });

    it('refuse de modifier ou supprimer un rôle système (409 system_role_immutable)', async () => {
      const id = await roleIdByCode(app, a, 'doctor');

      const patch = await http().patch(`${BASE}/roles/${id}`).set(bearer(a.adminToken)).send({ name: 'Piraté' }).expect(409);
      const del = await http().delete(`${BASE}/roles/${id}`).set(bearer(a.adminToken)).expect(409);

      expect(patch.body.code).toBe('system_role_immutable');
      expect(del.body.code).toBe('system_role_immutable');
    });

    it('refuse de supprimer un rôle affecté (409 role_in_use) puis l’autorise une fois l’affectation révoquée', async () => {
      const delegate = await createUserWithCustomPermissions(app, a, ['iam:user:read']);

      const blocked = await http().delete(`${BASE}/roles/${delegate.roleId}`).set(bearer(a.adminToken)).expect(409);
      const assignments = await http().get(`${BASE}/users/${delegate.userId}/assignments`).set(bearer(a.adminToken)).expect(200);
      await http().delete(`${BASE}/users/${delegate.userId}/assignments/${assignments.body.data[0].id}`).set(bearer(a.adminToken)).expect(204);
      await http().delete(`${BASE}/roles/${delegate.roleId}`).set(bearer(a.adminToken)).expect(204);

      expect(blocked.body.code).toBe('role_in_use');
      await http().get(`${BASE}/roles/${delegate.roleId}`).set(bearer(a.adminToken)).expect(404);
      expect((await auditEntries(app, a.tenantId, 'iam.role.deleted')).some((e) => e.resourceId === delegate.roleId)).toBe(true);
    });

    it('refuse modification et suppression à un rôle sans permission (403)', async () => {
      const role = await createCustomRole(app, a, []);

      await http().patch(`${BASE}/roles/${role.id}`).set(bearer(receptionist.token)).send({ name: 'Piraté' }).expect(403);
      await http().delete(`${BASE}/roles/${role.id}`).set(bearer(receptionist.token)).expect(403);
    });
  });

  describe('anti-escalade de privilèges (docs/04 §3.6)', () => {
    let delegate: { userId: string; token: string; roleId: string };

    beforeAll(async () => {
      delegate = await createUserWithCustomPermissions(app, a, ['iam:role:read', 'iam:role:create', 'iam:role:update', 'iam:user:read']);
    });

    it('autorise un acteur à composer un rôle avec des permissions qu’il détient', async () => {
      await postRole({ code: 'sous_ensemble', name: 'Sous-ensemble', permissions: ['iam:user:read'] }, delegate.token).expect(201);
    });

    it('refuse de créer un rôle contenant une permission non détenue (403 privilege_escalation)', async () => {
      const res = await postRole({ code: 'escalade', name: 'Escalade', permissions: ['iam:user:read', 'iam:user:delete'] }, delegate.token).expect(403);

      expect(res.body.code).toBe('privilege_escalation');
      expect(JSON.stringify(res.body)).not.toContain('iam:user:delete');
      const list = await http().get(`${BASE}/roles`).set(bearer(a.adminToken)).expect(200);
      expect(list.body.data.some((r: { code: string }) => r.code === 'escalade')).toBe(false);
    });

    it('refuse d’ajouter une permission non détenue à un rôle existant (403)', async () => {
      const role = await createCustomRole(app, a, ['iam:user:read'], 'cible_ajout');

      const res = await http().patch(`${BASE}/roles/${role.id}`).set(bearer(delegate.token)).send({ permissions: ['iam:user:read', 'org:site:delete'] }).expect(403);

      expect(res.body.code).toBe('privilege_escalation');
    });

    it('refuse de modifier un rôle qui contient des permissions que l’acteur ne détient pas, même pour les retirer', async () => {
      const powerful = await createCustomRole(app, a, ['iam:user:read', 'iam:user:delete'], 'puissant');

      const res = await http().patch(`${BASE}/roles/${powerful.id}`).set(bearer(delegate.token)).send({ permissions: ['iam:user:read'] }).expect(403);

      expect(res.body.code).toBe('privilege_escalation');
      const detail = await http().get(`${BASE}/roles/${powerful.id}`).set(bearer(a.adminToken)).expect(200);
      expect(detail.body.data.permissions).toContain('iam:user:delete');
    });

    it('limite l’administrateur lui-même aux permissions qu’il détient (aucune permission clinique)', async () => {
      const res = await postRole({ code: 'clinique', name: 'Clinique', permissions: ['consultations:consultation:read'] }).expect(403);

      expect(res.body.code).toBe('privilege_escalation');
    });

    it('exige une détention sur tout l’établissement pour composer un rôle depuis une portée de site', async () => {
      const siteRes = await http().post('/api/v1/org/sites').set(bearer(a.adminToken)).send({ code: 'ESC-S', name: 'Site escalade' }).expect(201);
      const scoped = await createUserWithCustomPermissions(app, a, ['iam:role:create', 'iam:user:read'], { scopeType: 'site', scopeId: siteRes.body.data.id });

      const res = await postRole({ code: 'depuis_site', name: 'Depuis site', permissions: ['iam:user:read'] }, scoped.token).expect(403);

      expect(res.body.code).toBe('privilege_escalation');
    });
  });
});
