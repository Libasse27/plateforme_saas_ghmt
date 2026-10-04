import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTenantFixture, createUserWithRole, issueToken, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { acceptInvitationFor } from '../helpers/invitations';
import { createTestApp } from '../helpers/test-app';
import { auditEntries, bearer, createCustomRole, createSite, createUserWithCustomPermissions, roleIdByCode } from './support';

const BASE = '/api/v1/iam/users';
const UNKNOWN_ID = '0198a000-0000-7000-8000-0000000000ff';
let counter = 0;

describe('iam : affectations, anti-escalade et dernier administrateur (HTTP)', () => {
  let app: INestApplication;
  let a: TenantFixture;
  let b: TenantFixture;
  let receptionist: UserFixture;
  let siteId: string;
  let viewerRoleId: string;
  const http = () => request(app.getHttpServer());

  const makeUser = async (tenant = a): Promise<string> => {
    counter += 1;
    const email = `u${counter}@${tenant.slug}.test`;
    const res = await http().post(BASE).set(bearer(tenant.adminToken)).send({ fullName: 'Utilisateur Test', email }).expect(201);
    // Utilisateur actif : invitation acceptée par le flux réel.
    await acceptInvitationFor(app, email);
    return res.body.data.id as string;
  };
  const assign = (userId: string, body: Record<string, unknown>, token = a.adminToken) =>
    http().post(`${BASE}/${userId}/assignments`).set(bearer(token)).send(body);

  beforeAll(async () => {
    app = await createTestApp();
    [a, b] = await Promise.all([createTenantFixture(app, { prefix: 'asg-a' }), createTenantFixture(app, { prefix: 'asg-b' })]);
    receptionist = await createUserWithRole(app, a, 'receptionist');
    siteId = await createSite(app, a, 'ASG-S1');
    viewerRoleId = (await createCustomRole(app, a, ['iam:user:read', 'org:site:read'], 'lecteur')).id;
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('création et révocation', () => {
    it('crée une affectation de portée établissement (201) et audite', async () => {
      const userId = await makeUser();

      const res = await assign(userId, { roleId: viewerRoleId, scopeType: 'tenant' }).expect(201);

      expect(res.body.data).toMatchObject({ roleId: viewerRoleId, roleCode: 'lecteur', scopeType: 'tenant', scopeId: null });
      const entry = (await auditEntries(app, a.tenantId, 'iam.assignment.created')).find((e) => e.resourceId === res.body.data.id);
      expect(entry?.changes).toMatchObject({ userId, after: { roleCode: 'lecteur', scopeType: 'tenant' } });
    });

    it('crée une affectation de portée site existant et de portée service existant', async () => {
      const userId = await makeUser();
      const dept = await http().post('/api/v1/org/departments').set(bearer(a.adminToken)).send({ siteId, code: `S${(counter += 1)}`, name: 'Service' }).expect(201);

      await assign(userId, { roleId: viewerRoleId, scopeType: 'site', scopeId: siteId }).expect(201);
      const res = await assign(userId, { roleId: viewerRoleId, scopeType: 'department', scopeId: dept.body.data.id }).expect(201);

      expect(res.body.data).toMatchObject({ scopeType: 'department', scopeId: dept.body.data.id });
    });

    it('applique l’affectation : l’utilisateur obtient les droits du rôle sur sa portée', async () => {
      const userId = await makeUser();
      const token = await issueToken(app, a.tenantId, userId);
      await http().get('/api/v1/org/sites').set(bearer(token)).expect(403);

      await assign(userId, { roleId: viewerRoleId, scopeType: 'site', scopeId: siteId }).expect(201);

      const res = await http().get('/api/v1/org/sites').set(bearer(token)).expect(200);
      expect(res.body.data.map((s: { id: string }) => s.id)).toEqual([siteId]);
    });

    it('refuse une portée inexistante, d’un autre établissement, ou d’un mauvais type (422 scope_not_found)', async () => {
      const userId = await makeUser();
      const foreignSite = await createSite(app, b, 'ASG-B1');
      const dept = await http().post('/api/v1/org/departments').set(bearer(a.adminToken)).send({ siteId, code: `T${(counter += 1)}`, name: 'Service' }).expect(201);

      const unknown = await assign(userId, { roleId: viewerRoleId, scopeType: 'site', scopeId: UNKNOWN_ID }).expect(422);
      const foreign = await assign(userId, { roleId: viewerRoleId, scopeType: 'site', scopeId: foreignSite }).expect(422);
      const siteAsDepartment = await assign(userId, { roleId: viewerRoleId, scopeType: 'department', scopeId: siteId }).expect(422);
      const departmentAsSite = await assign(userId, { roleId: viewerRoleId, scopeType: 'site', scopeId: dept.body.data.id }).expect(422);

      for (const res of [unknown, foreign, siteAsDepartment, departmentAsSite]) expect(res.body.code).toBe('scope_not_found');
    });

    it('refuse un rôle inconnu ou d’un autre établissement (422 role_not_found)', async () => {
      const userId = await makeUser();
      const foreignRole = await roleIdByCode(app, b, 'doctor');

      const unknown = await assign(userId, { roleId: UNKNOWN_ID, scopeType: 'tenant' }).expect(422);
      const foreign = await assign(userId, { roleId: foreignRole, scopeType: 'tenant' }).expect(422);

      expect(unknown.body.code).toBe('role_not_found');
      expect(foreign.body.code).toBe('role_not_found');
    });

    it.each([
      ['site sans scopeId', { scopeType: 'site' }],
      ['établissement avec scopeId', { scopeType: 'tenant', scopeId: UNKNOWN_ID }],
      ['type inconnu', { scopeType: 'groupe' }],
      ['roleId mal formé', { roleId: 'abc', scopeType: 'tenant' }],
    ])('rejette un corps invalide : %s (422 validation_failed)', async (_label, override) => {
      const userId = await makeUser();

      const res = await assign(userId, { roleId: viewerRoleId, ...override }).expect(422);

      expect(res.body.code).toBe('validation_failed');
    });

    it('refuse une date de fin passée (422) et accepte une date future', async () => {
      const userId = await makeUser();

      const past = await assign(userId, { roleId: viewerRoleId, scopeType: 'tenant', validUntil: '2020-01-01T00:00:00Z' }).expect(422);
      const future = await assign(userId, { roleId: viewerRoleId, scopeType: 'tenant', validUntil: '2999-01-01T00:00:00Z' }).expect(201);

      expect(past.body.code).toBe('invalid_validity');
      expect(future.body.data.validUntil).toBe('2999-01-01T00:00:00.000Z');
    });

    it('refuse une affectation en double (409 assignment_exists)', async () => {
      const userId = await makeUser();
      await assign(userId, { roleId: viewerRoleId, scopeType: 'tenant' }).expect(201);

      const res = await assign(userId, { roleId: viewerRoleId, scopeType: 'tenant' }).expect(409);

      expect(res.body.code).toBe('assignment_exists');
    });

    it('refuse à un rôle sans permission (403), sans jeton (401), et répond 404 pour un utilisateur d’un autre établissement', async () => {
      const userId = await makeUser();
      const foreignUser = await makeUser(b);

      await assign(userId, { roleId: viewerRoleId, scopeType: 'tenant' }, receptionist.token).expect(403);
      await http().post(`${BASE}/${userId}/assignments`).send({}).expect(401);
      await assign(foreignUser, { roleId: viewerRoleId, scopeType: 'tenant' }).expect(404);
      await assign(UNKNOWN_ID, { roleId: viewerRoleId, scopeType: 'tenant' }).expect(404);
    });

    it('révoque logiquement une affectation (204) : elle disparaît, les droits aussi, et la trace est auditée', async () => {
      const userId = await makeUser();
      const token = await issueToken(app, a.tenantId, userId);
      const created = await assign(userId, { roleId: viewerRoleId, scopeType: 'tenant' }).expect(201);
      await http().get('/api/v1/org/sites').set(bearer(token)).expect(200);

      await http().delete(`${BASE}/${userId}/assignments/${created.body.data.id}`).set(bearer(a.adminToken)).expect(204);

      const detail = await http().get(`${BASE}/${userId}`).set(bearer(a.adminToken)).expect(200);
      expect(detail.body.data.assignments).toEqual([]);
      await http().get('/api/v1/org/sites').set(bearer(token)).expect(403);
      expect((await auditEntries(app, a.tenantId, 'iam.assignment.revoked')).some((e) => e.resourceId === created.body.data.id)).toBe(true);
      await assign(userId, { roleId: viewerRoleId, scopeType: 'tenant' }).expect(201);
    });

    it('répond 404 pour une affectation déjà révoquée, inconnue ou d’un autre utilisateur', async () => {
      const userId = await makeUser();
      const otherId = await makeUser();
      const created = await assign(userId, { roleId: viewerRoleId, scopeType: 'tenant' }).expect(201);
      await http().delete(`${BASE}/${userId}/assignments/${created.body.data.id}`).set(bearer(a.adminToken)).expect(204);

      await http().delete(`${BASE}/${userId}/assignments/${created.body.data.id}`).set(bearer(a.adminToken)).expect(404);
      await http().delete(`${BASE}/${userId}/assignments/${UNKNOWN_ID}`).set(bearer(a.adminToken)).expect(404);
      const second = await assign(userId, { roleId: viewerRoleId, scopeType: 'site', scopeId: siteId }).expect(201);
      await http().delete(`${BASE}/${otherId}/assignments/${second.body.data.id}`).set(bearer(a.adminToken)).expect(404);
    });

    it('refuse la révocation sans permission (403) et répond 404 cross-tenant', async () => {
      const userId = await makeUser();
      const created = await assign(userId, { roleId: viewerRoleId, scopeType: 'tenant' }).expect(201);

      await http().delete(`${BASE}/${userId}/assignments/${created.body.data.id}`).set(bearer(receptionist.token)).expect(403);
      await http().delete(`${BASE}/${userId}/assignments/${created.body.data.id}`).set(bearer(b.adminToken)).expect(404);
    });
  });

  describe('anti-escalade sur les affectations', () => {
    it('permet à l’admin (sans droit clinique) de nommer un médecin et une réceptionniste', async () => {
      const userId = await makeUser();
      const doctorRoleId = await roleIdByCode(app, a, 'doctor');
      const receptionistRoleId = await roleIdByCode(app, a, 'receptionist');

      await assign(userId, { roleId: doctorRoleId, scopeType: 'tenant' }).expect(201);
      await assign(userId, { roleId: receptionistRoleId, scopeType: 'site', scopeId: siteId }).expect(201);

      const detail = await http().get(`${BASE}/${userId}`).set(bearer(a.adminToken)).expect(200);
      expect(detail.body.data.assignments).toHaveLength(2);
    });

    it('interdit à l’admin de s’attribuer lui-même un rôle clinique (403 privilege_escalation)', async () => {
      const doctorRoleId = await roleIdByCode(app, a, 'doctor');

      const res = await assign(a.adminUserId, { roleId: doctorRoleId, scopeType: 'tenant' }).expect(403);

      expect(res.body.code).toBe('privilege_escalation');
    });

    it('refuse d’affecter un rôle dont l’acteur ne détient pas toutes les permissions (403 privilege_escalation)', async () => {
      const delegate = await createUserWithCustomPermissions(app, a, ['iam:assignment:create', 'iam:user:read']);
      const userId = await makeUser();
      const adminRoleId = await roleIdByCode(app, a, 'tenant_admin');

      const res = await assign(userId, { roleId: adminRoleId, scopeType: 'tenant' }, delegate.token).expect(403);

      expect(res.body.code).toBe('privilege_escalation');
      const detail = await http().get(`${BASE}/${userId}`).set(bearer(a.adminToken)).expect(200);
      expect(detail.body.data.assignments).toEqual([]);
    });

    it('autorise d’affecter un rôle dont l’acteur détient toutes les permissions', async () => {
      const delegate = await createUserWithCustomPermissions(app, a, ['iam:assignment:create', 'iam:user:read']);
      const lowRole = (await createCustomRole(app, a, ['iam:user:read'])).id;

      await assign(await makeUser(), { roleId: lowRole, scopeType: 'tenant' }, delegate.token).expect(201);
    });

    it('refuse d’affecter sur une portée plus large que celle de l’acteur', async () => {
      const otherSite = await createSite(app, a, 'ASG-S2');
      const delegate = await createUserWithCustomPermissions(app, a, ['iam:assignment:create', 'iam:user:read', 'org:site:read'], {
        scopeType: 'site',
        scopeId: siteId,
      });
      const userId = await makeUser();

      const tenantScope = await assign(userId, { roleId: viewerRoleId, scopeType: 'tenant' }, delegate.token).expect(403);
      const otherScope = await assign(userId, { roleId: viewerRoleId, scopeType: 'site', scopeId: otherSite }, delegate.token).expect(403);
      await assign(userId, { roleId: viewerRoleId, scopeType: 'site', scopeId: siteId }, delegate.token).expect(201);

      expect(tenantScope.body.code).toBe('privilege_escalation');
      expect(otherScope.body.code).toBe('privilege_escalation');
    });

    it('refuse, à la création d’un utilisateur, une affectation dépassant les droits de l’acteur', async () => {
      const delegate = await createUserWithCustomPermissions(app, a, ['iam:user:create', 'iam:user:read']);
      const adminRoleId = await roleIdByCode(app, a, 'tenant_admin');
      counter += 1;

      const res = await http()
        .post(BASE)
        .set(bearer(delegate.token))
        .send({ fullName: 'Nouvel Admin', email: `x${counter}@${a.slug}.test`, roleAssignments: [{ roleId: adminRoleId, scopeType: 'tenant' }] })
        .expect(403);

      expect(res.body.code).toBe('privilege_escalation');
      const list = await http().get(BASE).query({ q: `x${counter}@`, limit: 100 }).set(bearer(a.adminToken)).expect(200);
      expect(list.body.data).toEqual([]);
    });

    it('refuse la révocation d’une affectation dont l’acteur ne détient pas les droits', async () => {
      const delegate = await createUserWithCustomPermissions(app, a, ['iam:assignment:delete', 'iam:user:read']);
      const adminAssignments = await http().get(`${BASE}/${a.adminUserId}/assignments`).set(bearer(a.adminToken)).expect(200);

      const res = await http().delete(`${BASE}/${a.adminUserId}/assignments/${adminAssignments.body.data[0].id}`).set(bearer(delegate.token)).expect(403);

      expect(res.body.code).toBe('privilege_escalation');
    });
  });

  describe('invariant : dernier administrateur actif (409 last_admin)', () => {
    it('empêche le seul administrateur de se désactiver ou de perdre son rôle', async () => {
      const solo = await createTenantFixture(app, { prefix: 'asg-solo' });
      const assignments = await http().get(`${BASE}/${solo.adminUserId}/assignments`).set(bearer(solo.adminToken)).expect(200);

      const disable = await http().post(`${BASE}/${solo.adminUserId}/disable`).set(bearer(solo.adminToken)).expect(409);
      const revoke = await http().delete(`${BASE}/${solo.adminUserId}/assignments/${assignments.body.data[0].id}`).set(bearer(solo.adminToken)).expect(409);

      expect(disable.body.code).toBe('last_admin');
      expect(revoke.body.code).toBe('last_admin');
      await http().get('/api/v1/org/sites').set(bearer(solo.adminToken)).expect(200);
    });

    it('autorise le retrait d’un administrateur tant qu’un autre administrateur actif subsiste, puis protège le dernier', async () => {
      const t = await createTenantFixture(app, { prefix: 'asg-duo' });
      const adminRoleId = await roleIdByCode(app, t, 'tenant_admin');
      counter += 1;
      const second = await http()
        .post(BASE)
        .set(bearer(t.adminToken))
        .send({ fullName: 'Second Admin', email: `second${counter}@${t.slug}.test`, roleAssignments: [{ roleId: adminRoleId, scopeType: 'tenant' }] })
        .expect(201);
      await acceptInvitationFor(app, `second${counter}@${t.slug}.test`);
      const secondToken = await issueToken(app, t.tenantId, second.body.data.id);

      await http().post(`${BASE}/${t.adminUserId}/disable`).set(bearer(secondToken)).expect(200);

      const last = await http().post(`${BASE}/${second.body.data.id}/disable`).set(bearer(secondToken)).expect(409);
      expect(last.body.code).toBe('last_admin');
      await http().get(`${BASE}/${t.adminUserId}`).set(bearer(secondToken)).expect(200);
    });

    it('compte la désactivation d’un administrateur comme une perte (le second administrateur désactivé ne compte pas)', async () => {
      const t = await createTenantFixture(app, { prefix: 'asg-trio' });
      const adminRoleId = await roleIdByCode(app, t, 'tenant_admin');
      counter += 1;
      const second = await http()
        .post(BASE)
        .set(bearer(t.adminToken))
        .send({ fullName: 'Second Admin', email: `trio${counter}@${t.slug}.test`, roleAssignments: [{ roleId: adminRoleId, scopeType: 'tenant' }] })
        .expect(201);
      await acceptInvitationFor(app, `trio${counter}@${t.slug}.test`);
      await http().post(`${BASE}/${second.body.data.id}/disable`).set(bearer(t.adminToken)).expect(200);

      const res = await http().post(`${BASE}/${t.adminUserId}/disable`).set(bearer(t.adminToken)).expect(409);

      expect(res.body.code).toBe('last_admin');
    });

    it('autorise la révocation de l’affectation administrateur d’un utilisateur quand un autre administrateur existe', async () => {
      const t = await createTenantFixture(app, { prefix: 'asg-rev' });
      const adminRoleId = await roleIdByCode(app, t, 'tenant_admin');
      counter += 1;
      const second = await http()
        .post(BASE)
        .set(bearer(t.adminToken))
        .send({ fullName: 'Second Admin', email: `rev${counter}@${t.slug}.test`, roleAssignments: [{ roleId: adminRoleId, scopeType: 'tenant' }] })
        .expect(201);

      await http().delete(`${BASE}/${second.body.data.id}/assignments/${second.body.data.assignments[0].id}`).set(bearer(t.adminToken)).expect(204);
    });
  });
});
