import { createHash, randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { LoginDelayService } from '../../src/modules/auth/services/login-delay.service';
import { bearer, http } from '../auth/auth-helpers';
import { createTenantFixture, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { activateTotp, auditEntries } from './support';

const USERS = '/api/v1/iam/users';
const REASON = 'Identité vérifiée en face à face au secrétariat.';

describe('iam : sécurité des comptes utilisateurs (docs/11 §14.1)', () => {
  let app: INestApplication;
  let tenant: TenantFixture;
  let other: TenantFixture;
  let admin2: UserFixture;
  let director: UserFixture;

  const notificationsOf = (typeCode: string) =>
    app.get(TenantDb).runAs(tenant.tenantId, (t) => t.notification.findMany({ where: { typeCode }, select: { recipientId: true, channel: true, context: true } }));

  beforeAll(async () => {
    app = await createTestApp();
    [tenant, other] = await Promise.all([createTenantFixture(app, { prefix: 'usec' }), createTenantFixture(app, { prefix: 'usec-b' })]);
    [admin2, director] = await Promise.all([createUserWithRole(app, tenant, 'tenant_admin'), createUserWithRole(app, tenant, 'director')]);
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('motif obligatoire : DELETE /iam/users/{id}/mfa et POST /iam/users/{id}/unlock', () => {
    it.each([
      ['absent', undefined],
      ['trop court', 'court'],
      ['trop long', 'x'.repeat(501)],
    ])('refuse un motif %s (422 validation_failed)', async (_label, reason) => {
      const target = await createUserWithRole(app, tenant, 'doctor');
      await activateTotp(app, tenant.tenantId, target.userId);
      const body = reason === undefined ? {} : { reason };

      expect((await http(app).delete(`${USERS}/${target.userId}/mfa`).set(bearer(admin2.token)).send(body).expect(422)).body.code).toBe('validation_failed');
      expect((await http(app).post(`${USERS}/${target.userId}/unlock`).set(bearer(admin2.token)).send(body).expect(422)).body.code).toBe('validation_failed');
    });

    it('reprend le motif dans l’audit du déverrouillage', async () => {
      const target = await createUserWithRole(app, tenant, 'cashier');

      await http(app).post(`${USERS}/${target.userId}/unlock`).set(bearer(admin2.token)).send({ reason: REASON }).expect(200);

      const audits = (await auditEntries(app, tenant.tenantId, 'iam.user.unlocked')).filter((a) => a.resourceId === target.userId);
      expect(audits[0]!.changes).toMatchObject({ reason: REASON });
    });

    it('reprend le motif dans l’audit de la réinitialisation du second facteur et prévient les directeurs et le principal', async () => {
      const target = await createUserWithRole(app, tenant, 'doctor');
      await activateTotp(app, tenant.tenantId, target.userId);

      await http(app).delete(`${USERS}/${target.userId}/mfa`).set(bearer(admin2.token)).send({ reason: REASON }).expect(204);

      const audits = (await auditEntries(app, tenant.tenantId, 'iam.user.mfa_reset')).filter((a) => a.resourceId === target.userId);
      expect(audits[0]!.changes).toMatchObject({ reason: REASON, revokedSessions: expect.any(Number) });
      const alerts = (await notificationsOf('security.mfa_reset')).filter((n) => (n.context as { targetUserId?: string }).targetUserId === target.userId);
      expect(new Set(alerts.map((a) => a.recipientId))).toEqual(new Set([director.userId, tenant.adminUserId]));
      expect(alerts.some((a) => a.recipientId === admin2.userId || a.recipientId === target.userId)).toBe(false);
    });
  });

  describe('GET /iam/users et /iam/users/{id} : mfaEnrolled et loginDelayed', () => {
    it('indique le second facteur actif et la connexion ralentie', async () => {
      const [enrolled, delayed, plain] = await Promise.all([
        createUserWithRole(app, tenant, 'doctor'),
        createUserWithRole(app, tenant, 'nurse'),
        createUserWithRole(app, tenant, 'cashier'),
      ]);
      await activateTotp(app, tenant.tenantId, enrolled.userId);
      const delay = app.get(LoginDelayService, { strict: false });
      // Échecs amorcés par la voie de production : chaque tentative admise est comptée comme un échec.
      for (let i = 0; i < 5; i += 1) await delay.admit(tenant.slug, delayed.email, new Date());

      const list = await http(app).get(`${USERS}?limit=100`).set(bearer(tenant.adminToken)).expect(200);
      const byId = new Map((list.body.data as { id: string; mfaEnrolled: boolean; loginDelayed: boolean }[]).map((u) => [u.id, u]));

      expect(byId.get(enrolled.userId)).toMatchObject({ mfaEnrolled: true, loginDelayed: false });
      expect(byId.get(delayed.userId)).toMatchObject({ mfaEnrolled: false, loginDelayed: true });
      expect(byId.get(plain.userId)).toMatchObject({ mfaEnrolled: false, loginDelayed: false });
      const detail = await http(app).get(`${USERS}/${delayed.userId}`).set(bearer(tenant.adminToken)).expect(200);
      expect(detail.body.data).toMatchObject({ mfaEnrolled: false, loginDelayed: true });

      await http(app).post(`${USERS}/${delayed.userId}/unlock`).set(bearer(tenant.adminToken)).send({ reason: REASON }).expect(200);
      const after = await http(app).get(`${USERS}/${delayed.userId}`).set(bearer(tenant.adminToken)).expect(200);
      expect(after.body.data.loginDelayed).toBe(false);
    });
  });

  describe('réinitialisation du second facteur', () => {
    it('invalide les jetons de réinitialisation du mot de passe en cours et le consigne dans l’audit', async () => {
      const target = await createUserWithRole(app, tenant, 'doctor');
      await activateTotp(app, tenant.tenantId, target.userId);
      await app.get(TenantDb).runAs(tenant.tenantId, (t) =>
        t.passwordResetToken.create({
          data: { tenantId: tenant.tenantId, userId: target.userId, tokenHash: createHash('sha256').update(randomBytes(32)).digest(), expiresAt: new Date(Date.now() + 30 * 60_000) },
        }),
      );

      await http(app).delete(`${USERS}/${target.userId}/mfa`).set(bearer(admin2.token)).send({ reason: REASON }).expect(204);

      const open = await app.get(TenantDb).runAs(tenant.tenantId, (t) => t.passwordResetToken.count({ where: { userId: target.userId, consumedAt: null } }));
      expect(open).toBe(0);
      const audits = (await auditEntries(app, tenant.tenantId, 'iam.user.mfa_reset')).filter((a) => a.resourceId === target.userId);
      expect(audits[0]!.changes).toMatchObject({ invalidatedResetTokens: 1 });
    });
  });

  describe('désactivation', () => {
    it('invalide les jetons de réinitialisation du mot de passe en cours', async () => {
      const target = await createUserWithRole(app, tenant, 'cashier');
      await app.get(TenantDb).runAs(tenant.tenantId, (t) =>
        t.passwordResetToken.create({
          data: { tenantId: tenant.tenantId, userId: target.userId, tokenHash: createHash('sha256').update(randomBytes(32)).digest(), expiresAt: new Date(Date.now() + 30 * 60_000) },
        }),
      );

      await http(app).post(`${USERS}/${target.userId}/disable`).set(bearer(admin2.token)).expect(200);

      const open = await app.get(TenantDb).runAs(tenant.tenantId, (t) => t.passwordResetToken.count({ where: { userId: target.userId, consumedAt: null } }));
      expect(open).toBe(0);
    });

    it('prévient le principal et les autres directeurs quand un directeur est désactivé', async () => {
      const removed = await createUserWithRole(app, tenant, 'director');

      await http(app).post(`${USERS}/${removed.userId}/disable`).set(bearer(admin2.token)).expect(200);

      const alerts = (await notificationsOf('security.director_removed')).filter((n) => (n.context as { targetUserId?: string }).targetUserId === removed.userId);
      expect(new Set(alerts.map((a) => a.recipientId))).toEqual(new Set([director.userId, tenant.adminUserId]));
    });

    it('prévient aussi quand un directeur perd son rôle de directeur, pas pour un autre rôle', async () => {
      const removed = await createUserWithRole(app, tenant, 'director');
      const assignment = await app.get(TenantDb).runAs(tenant.tenantId, (t) => t.userRoleAssignment.findFirstOrThrow({ where: { userId: removed.userId }, select: { id: true } }));
      const cashier = await createUserWithRole(app, tenant, 'cashier');
      const cashierAssignment = await app.get(TenantDb).runAs(tenant.tenantId, (t) => t.userRoleAssignment.findFirstOrThrow({ where: { userId: cashier.userId }, select: { id: true } }));

      await http(app).delete(`${USERS}/${removed.userId}/assignments/${assignment.id}`).set(bearer(tenant.adminToken)).expect(204);
      await http(app).delete(`${USERS}/${cashier.userId}/assignments/${cashierAssignment.id}`).set(bearer(tenant.adminToken)).expect(204);

      const alerts = await notificationsOf('security.director_removed');
      const forRemoved = alerts.filter((n) => (n.context as { targetUserId?: string }).targetUserId === removed.userId);
      expect(new Set(forRemoved.map((a) => a.recipientId))).toEqual(new Set([director.userId]));
      expect(alerts.some((n) => (n.context as { targetUserId?: string }).targetUserId === cashier.userId)).toBe(false);
    });
  });

  it('404 pour un utilisateur d’un autre établissement (motif valide)', async () => {
    await http(app).post(`${USERS}/${other.adminUserId}/unlock`).set(bearer(tenant.adminToken)).send({ reason: REASON }).expect(404);
    await http(app).delete(`${USERS}/${other.adminUserId}/mfa`).set(bearer(tenant.adminToken)).send({ reason: REASON }).expect(404);
  });
});
