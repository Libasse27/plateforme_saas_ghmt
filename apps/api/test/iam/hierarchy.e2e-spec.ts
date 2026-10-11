import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { bearer, enrollTotp, http, memoryMailer } from '../auth/auth-helpers';
import { createTenantFixture, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { activateTotp, roleIdByCode, stepUpCode, wrongTotpCode } from './support';

const USERS = '/api/v1/iam/users';
const OWNER_URL = '/api/v1/iam/security/owner';
const REASON = 'Identité vérifiée par rappel sur le numéro connu.';

describe('iam : hiérarchie entre administrateurs et administrateur principal (docs/11 D9)', () => {
  let app: INestApplication;
  let tenant: TenantFixture;
  let other: TenantFixture;
  let admin2: UserFixture;
  let admin3: UserFixture;
  let doctor: UserFixture;
  let ownerSecret: string;

  const as = (token: string) => ({
    patch: (id: string, body: Record<string, unknown> = { fullName: 'Nouveau Nom' }) => http(app).patch(`${USERS}/${id}`).set(bearer(token)).send(body),
    disable: (id: string) => http(app).post(`${USERS}/${id}/disable`).set(bearer(token)),
    enable: (id: string) => http(app).post(`${USERS}/${id}/enable`).set(bearer(token)),
    unlock: (id: string) => http(app).post(`${USERS}/${id}/unlock`).set(bearer(token)).send({ reason: REASON }),
    sessions: (id: string) => http(app).delete(`${USERS}/${id}/sessions`).set(bearer(token)),
    mfa: (id: string) => http(app).delete(`${USERS}/${id}/mfa`).set(bearer(token)).send({ reason: REASON }),
    invitation: (id: string) => http(app).post(`${USERS}/${id}/invitation`).set(bearer(token)),
    assign: (id: string, roleId: string) => http(app).post(`${USERS}/${id}/assignments`).set(bearer(token)).send({ roleId, scopeType: 'tenant' }),
    invite: (roleId: string) =>
      http(app).post(USERS).set(bearer(token)).send({ fullName: 'Invité Test', email: `inv-${Math.random().toString(36).slice(2, 8)}@${tenant.slug}.test`, roleAssignments: [{ roleId, scopeType: 'tenant' }] }),
    transfer: (userId: string, totpCode?: string) => http(app).post(OWNER_URL).set(bearer(token)).send({ userId, ...(totpCode ? { totpCode } : {}) }),
  });
  const adminAssignmentOf = (userId: string) =>
    app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.userRoleAssignment.findFirstOrThrow({ where: { userId, revokedAt: null, role: { code: 'tenant_admin' } }, select: { id: true } }));
  const policyOwner = async (): Promise<string | null> =>
    app.get(TenantDb).runAs(tenant.tenantId, async (tx) => (await tx.securitySettings.findFirst())?.ownerUserId ?? null);

  beforeAll(async () => {
    app = await createTestApp();
    [tenant, other] = await Promise.all([createTenantFixture(app, { prefix: 'hier' }), createTenantFixture(app, { prefix: 'hier-b' })]);
    [admin2, admin3, doctor] = await Promise.all([
      createUserWithRole(app, tenant, 'tenant_admin'),
      createUserWithRole(app, tenant, 'tenant_admin'),
      createUserWithRole(app, tenant, 'doctor', { scopeType: 'tenant' }, true),
    ]);
    ownerSecret = await activateTotp(app, tenant.tenantId, tenant.adminUserId);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('pose l’administrateur principal à la création de l’établissement, sans le changer aux affectations suivantes', async () => {
    expect(await policyOwner()).toBe(tenant.adminUserId);
  });

  describe('un administrateur non principal', () => {
    it.each([
      ['modifier', (a: ReturnType<typeof as>, id: string) => a.patch(id)],
      ['désactiver', (a: ReturnType<typeof as>, id: string) => a.disable(id)],
      ['réactiver', (a: ReturnType<typeof as>, id: string) => a.enable(id)],
      ['déverrouiller', (a: ReturnType<typeof as>, id: string) => a.unlock(id)],
      ['révoquer les sessions de', (a: ReturnType<typeof as>, id: string) => a.sessions(id)],
      ['réinitialiser le MFA de', (a: ReturnType<typeof as>, id: string) => a.mfa(id)],
      ['renvoyer l’invitation de', (a: ReturnType<typeof as>, id: string) => a.invitation(id)],
    ])('ne peut pas %s le principal ni un autre administrateur (403 admin_hierarchy)', async (_label, act) => {
      for (const target of [tenant.adminUserId, admin3.userId]) {
        const res = await act(as(admin2.token), target).expect(403);
        expect(res.body.code).toBe('admin_hierarchy');
        expect(res.body.detail).toBe('Seul l’administrateur principal peut agir sur un autre administrateur.');
      }
    });

    it('ne peut ni affecter ni retirer un rôle d’un autre administrateur', async () => {
      const assignment = await adminAssignmentOf(admin3.userId);
      const doctorRole = await roleIdByCode(app, tenant, 'doctor');

      expect((await as(admin2.token).assign(admin3.userId, doctorRole).expect(403)).body.code).toBe('admin_hierarchy');
      const revoke = await http(app).delete(`${USERS}/${admin3.userId}/assignments/${assignment.id}`).set(bearer(admin2.token)).expect(403);
      expect(revoke.body.code).toBe('admin_hierarchy');
    });

    it('peut agir sur un utilisateur ordinaire (modifier, désactiver, réactiver, déverrouiller, couper les sessions)', async () => {
      const target = await createUserWithRole(app, tenant, 'cashier');
      const actions = as(admin2.token);

      await actions.patch(target.userId).expect(200);
      await actions.unlock(target.userId).expect(200);
      await actions.sessions(target.userId).expect(204);
      await actions.disable(target.userId).expect(200);
      await actions.enable(target.userId).expect(200);
    });

    it('ne peut ni affecter ni inviter avec un rôle d’administration en écriture (403 owner_required)', async () => {
      const adminRole = await roleIdByCode(app, tenant, 'tenant_admin');

      expect((await as(admin2.token).assign(doctor.userId, adminRole).expect(403)).body.code).toBe('owner_required');
      expect((await as(admin2.token).invite(adminRole).expect(403)).body.code).toBe('owner_required');
    });
  });

  describe('rôles : ajout d’un droit d’administration (H3, docs/11 §14.1)', () => {
    const ROLES = '/api/v1/iam/roles';
    const createRole = (token: string, permissions: string[]) =>
      http(app).post(ROLES).set(bearer(token)).send({ code: `h3_${Math.random().toString(36).slice(2, 8)}`, name: 'Rôle H3', permissions });
    const patchRole = (token: string, id: string, permissions: string[]) => http(app).patch(`${ROLES}/${id}`).set(bearer(token)).send({ permissions });
    const assignRole = async (userId: string, roleId: string) => as(tenant.adminToken).assign(userId, roleId).expect(201);

    it('un non-principal ne peut pas créer un rôle portant un droit d’administration en écriture (403 owner_required)', async () => {
      expect((await createRole(admin2.token, ['org:site:read', 'iam:user:update']).expect(403)).body.code).toBe('owner_required');
      await createRole(admin2.token, ['org:site:read', 'iam:user:read']).expect(201);
      await createRole(tenant.adminToken, ['org:site:read', 'iam:user:update']).expect(201);
    });

    it('un non-principal ne peut pas ajouter un droit d’administration en écriture à un rôle affecté (403 owner_required)', async () => {
      const role = (await createRole(tenant.adminToken, ['org:site:read']).expect(201)).body.data;
      const holder = await createUserWithRole(app, tenant, 'cashier');
      await assignRole(holder.userId, role.id);

      const res = await patchRole(admin2.token, role.id, ['org:site:read', 'iam:user:update']).expect(403);

      expect(res.body.code).toBe('owner_required');
      await patchRole(admin2.token, role.id, ['org:site:read', 'org:service:read']).expect(200);
      await patchRole(tenant.adminToken, role.id, ['org:site:read', 'iam:user:update']).expect(200);
    });

    it('un non-principal peut modifier un rôle non affecté, même avec un droit d’administration', async () => {
      const role = (await createRole(tenant.adminToken, ['org:site:read']).expect(201)).body.data;

      await patchRole(admin2.token, role.id, ['org:site:read', 'iam:user:update']).expect(200);
    });

    it('un non-principal ne peut pas modifier un rôle détenu par un autre administrateur (403 admin_hierarchy)', async () => {
      const role = (await createRole(tenant.adminToken, ['org:site:read']).expect(201)).body.data;
      await assignRole(admin3.userId, role.id);

      const res = await patchRole(admin2.token, role.id, ['org:site:read', 'org:service:read']).expect(403);

      expect(res.body.code).toBe('admin_hierarchy');
      await patchRole(tenant.adminToken, role.id, ['org:site:read', 'org:service:read']).expect(200);
    });
  });

  describe('l’administrateur principal', () => {
    it('peut agir sur les autres administrateurs, accorder un rôle d’administration et inviter avec', async () => {
      const owner = as(tenant.adminToken);
      const adminRole = await roleIdByCode(app, tenant, 'tenant_admin');

      await owner.patch(admin3.userId).expect(200);
      await owner.unlock(admin3.userId).expect(200);
      expect((await owner.invite(adminRole).expect(201)).body.data.assignments[0].roleCode).toBe('tenant_admin');
      const promoted = await createUserWithRole(app, tenant, 'cashier');
      await owner.assign(promoted.userId, adminRole).expect(201);
    });

    it('ne peut pas se désactiver (409 owner_must_transfer) ni perdre son rôle tenant_admin', async () => {
      const own = await adminAssignmentOf(tenant.adminUserId);

      expect((await as(tenant.adminToken).disable(tenant.adminUserId).expect(409)).body.code).toBe('owner_must_transfer');
      const revoke = await http(app).delete(`${USERS}/${tenant.adminUserId}/assignments/${own.id}`).set(bearer(tenant.adminToken)).expect(409);
      expect(revoke.body.code).toBe('owner_must_transfer');
    });

    it('expose isOwner et lastSeenAt dans les vues utilisateur', async () => {
      const detail = await http(app).get(`${USERS}/${tenant.adminUserId}`).set(bearer(tenant.adminToken)).expect(200);
      const list = await http(app).get(`${USERS}?limit=100`).set(bearer(tenant.adminToken)).expect(200);

      expect(detail.body.data).toMatchObject({ isOwner: true, lastSeenAt: null });
      const rows = list.body.data as { id: string; isOwner: boolean }[];
      expect(rows.filter((r) => r.isOwner).map((r) => r.id)).toEqual([tenant.adminUserId]);
    });
  });

  describe('POST /iam/security/owner', () => {
    it('refuse à un non-principal (403 owner_required)', async () => {
      expect((await as(admin2.token).transfer(admin3.userId).expect(403)).body.code).toBe('owner_required');
    });

    it.each([
      ['soi-même', () => tenant.adminUserId],
      ['un administrateur sans second facteur actif', () => admin2.userId],
      ['un utilisateur qui n’est pas administrateur', () => doctor.userId],
    ])('refuse comme cible : %s (422 owner_target_invalid)', async (_label, target) => {
      const res = await as(tenant.adminToken).transfer(target()).expect(422);

      expect(res.body.code).toBe('owner_target_invalid');
    });

    it('refuse un identifiant mal formé (422) et un utilisateur d’un autre établissement (422)', async () => {
      await as(tenant.adminToken).transfer('pas-un-uuid').expect(422);
      expect((await as(tenant.adminToken).transfer(other.adminUserId).expect(422)).body.code).toBe('owner_target_invalid');
    });

    it('exige le code TOTP du principal (401 mfa_step_up_required, 401 mfa_code_invalid)', async () => {
      const heir = await createUserWithRole(app, tenant, 'tenant_admin');
      await activateTotp(app, tenant.tenantId, heir.userId);

      expect((await as(tenant.adminToken).transfer(heir.userId).expect(401)).body.code).toBe('mfa_step_up_required');
      expect((await as(tenant.adminToken).transfer(heir.userId, await wrongTotpCode(ownerSecret)).expect(401)).body.code).toBe('mfa_code_invalid');
      expect(await policyOwner()).toBe(tenant.adminUserId);
    });

    it('transfère le titre vers un administrateur avec TOTP, audite, et inverse les rangs', async () => {
      await enrollTotp(app, admin2.token, admin2.email);

      const res = await as(tenant.adminToken).transfer(admin2.userId, await stepUpCode(app, tenant.tenantId, tenant.adminUserId, ownerSecret)).expect(200);

      expect(res.body.data.owner).toMatchObject({ id: admin2.userId });
      expect(await policyOwner()).toBe(admin2.userId);
      const audits = await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.auditLog.findMany({ where: { action: 'iam.owner.transferred' } }));
      expect(audits).toHaveLength(1);
      expect(audits[0]!.changes).toEqual({ fromUserId: tenant.adminUserId, toUserId: admin2.userId });
      // Alerte au nouveau principal (personne visée), jamais à l'auteur du transfert.
      const alerts = await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.notification.findMany({ where: { typeCode: 'security.owner_transferred' }, select: { recipientId: true } }));
      expect(new Set(alerts.map((a) => a.recipientId))).toEqual(new Set([admin2.userId]));
      // Rangs inversés : l'ancien principal (rang 1) ne peut plus agir sur le nouveau, qui le peut sur lui.
      expect((await as(tenant.adminToken).disable(admin2.userId).expect(403)).body.code).toBe('admin_hierarchy');
      expect((await as(tenant.adminToken).transfer(admin3.userId).expect(403)).body.code).toBe('owner_required');
      await as(admin2.token).patch(tenant.adminUserId).expect(200);
    });

    it('après transfert, le nouveau principal ne peut pas perdre son rôle tenant_admin (409 owner_must_transfer)', async () => {
      const solo = await createTenantFixture(app, { prefix: 'hier-solo' });
      const heir = await createUserWithRole(app, solo, 'tenant_admin');
      const own = await app.get(TenantDb).runAs(solo.tenantId, (tx) => tx.userRoleAssignment.findFirstOrThrow({ where: { userId: heir.userId, role: { code: 'tenant_admin' } }, select: { id: true } }));
      // Le principal d'origine est désactivé sans lien avec l'héritier : il faut d'abord transférer.
      await enrollTotp(app, heir.token, heir.email);
      const soloSecret = await activateTotp(app, solo.tenantId, solo.adminUserId);
      const totpCode = await stepUpCode(app, solo.tenantId, solo.adminUserId, soloSecret);
      await http(app).post(OWNER_URL).set(bearer(solo.adminToken)).send({ userId: heir.userId, totpCode }).expect(200);
      await http(app).post(`${USERS}/${solo.adminUserId}/disable`).set(bearer(heir.token)).expect(200);

      const res = await http(app).delete(`${USERS}/${heir.userId}/assignments/${own.id}`).set(bearer(heir.token)).expect(409);

      expect(res.body.code).toBe('owner_must_transfer');
    });
  });

  describe('DELETE /iam/users/{id}/mfa', () => {
    it('supprime le facteur, révoque toutes les sessions, audite et prévient l’intéressé par e-mail', async () => {
      const target = await createUserWithRole(app, tenant, 'doctor', { scopeType: 'tenant' }, true);
      await enrollTotp(app, target.token, target.email);
      memoryMailer(app).clear();

      await as(admin2.token).mfa(target.userId).expect(204);

      await http(app).get('/api/v1/auth/me').set(bearer(target.token)).expect(401);
      const factors = await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.mfaFactor.count({ where: { userId: target.userId } }));
      expect(factors).toBe(0);
      const mail = memoryMailer(app).lastTo(target.email)!;
      expect(mail.subject).toContain('second facteur');
      const audits = await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.auditLog.findMany({ where: { action: 'iam.user.mfa_reset', resourceId: target.userId } }));
      expect(audits).toHaveLength(1);
    });

    it('répond 409 sans facteur, 422 sur soi-même, 404 inconnu ou d’un autre établissement, 403 sans permission', async () => {
      const plain = await createUserWithRole(app, tenant, 'cashier');
      const director = await createUserWithRole(app, tenant, 'director');

      expect((await as(admin2.token).mfa(plain.userId).expect(409)).body.code).toBe('mfa_not_enrolled');
      expect((await as(admin2.token).mfa(admin2.userId).expect(422)).body.code).toBe('self_mfa_reset');
      await as(admin2.token).mfa('0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b').expect(404);
      await as(admin2.token).mfa(other.adminUserId).expect(404);
      await as(admin2.token).mfa('pas-un-uuid').expect(404);
      await as(director.token).mfa(plain.userId).expect(403);
    });
  });
});
