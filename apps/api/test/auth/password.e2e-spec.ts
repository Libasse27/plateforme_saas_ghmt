import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { FIXTURE_PASSWORD, createTenantFixture, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { AUTH, bearer, distinctClientIp, http, loginOk, postLogin } from './auth-helpers';

const NEW_PASSWORD = 'Nouveau-mot-de-passe-2026';

describe('auth : changement de mot de passe et mustChangePassword (C7)', () => {
  let app: INestApplication;
  let tenantDb: TenantDb;
  let a: TenantFixture;
  let b: TenantFixture;

  const change = (token: string, body: Record<string, unknown>) => http(app).post(`${AUTH}/password/change`).set('X-Forwarded-For', distinctClientIp()).set(bearer(token)).send(body);
  const sites = (token: string) => http(app).get('/api/v1/org/sites').set(bearer(token));
  const newUser = (tenant = a): Promise<UserFixture> => createUserWithRole(app, tenant, 'receptionist');
  const forceChange = (tenantId: string, userId: string) =>
    tenantDb.runAs(tenantId, (tx) => tx.userCredential.update({ where: { tenantId_userId: { tenantId, userId } }, data: { mustChangePassword: true } }));

  beforeAll(async () => {
    app = await createTestApp();
    tenantDb = app.get(TenantDb);
    [a, b] = await Promise.all([createTenantFixture(app, { prefix: 'pwd-a' }), createTenantFixture(app, { prefix: 'pwd-b' })]);
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('mustChangePassword', () => {
    it('bloque les routes à permission avec 403 password_change_required, mais pas /auth/me ni le changement', async () => {
      const user = await newUser();
      await forceChange(a.tenantId, user.userId);
      const session = await loginOk(app, a, user.email);

      const blocked = await sites(session.accessToken).expect(403);
      const me = await http(app).get(`${AUTH}/me`).set(bearer(session.accessToken)).expect(200);
      await change(session.accessToken, { currentPassword: FIXTURE_PASSWORD, newPassword: NEW_PASSWORD }).expect(204);

      expect(blocked.body.code).toBe('password_change_required');
      expect(me.body.data.user.mustChangePassword).toBe(true);
      await sites(session.accessToken).expect(200);
      const meAfter = await http(app).get(`${AUTH}/me`).set(bearer(session.accessToken)).expect(200);
      expect(meAfter.body.data.user.mustChangePassword).toBe(false);
    });

    it('ne gêne pas un utilisateur sans obligation de changement', async () => {
      const user = await newUser();

      await sites(user.token).expect(200);
    });
  });

  describe('POST /auth/password/change', () => {
    it('change le mot de passe : l’ancien est refusé, le nouveau accepté, le hash est mis à jour', async () => {
      const user = await newUser();
      const before = await tenantDb.runAs(a.tenantId, (tx) => tx.userCredential.findFirstOrThrow({ where: { userId: user.userId } }));
      const session = await loginOk(app, a, user.email);

      await change(session.accessToken, { currentPassword: FIXTURE_PASSWORD, newPassword: NEW_PASSWORD }).expect(204);

      await postLogin(app, a.slug, user.email, FIXTURE_PASSWORD).expect(401);
      await postLogin(app, a.slug, user.email, NEW_PASSWORD).expect(200);
      const after = await tenantDb.runAs(a.tenantId, (tx) => tx.userCredential.findFirstOrThrow({ where: { userId: user.userId } }));
      expect(after.passwordHash).not.toBe(before.passwordHash);
      expect(after.passwordHash).toMatch(/^\$argon2id\$/);
      expect(after.passwordChangedAt.getTime()).toBeGreaterThan(before.passwordChangedAt.getTime());
    });

    it('révoque les autres sessions et conserve la session courante', async () => {
      const user = await newUser();
      const current = await loginOk(app, a, user.email);
      const other = await loginOk(app, a, user.email);

      await change(current.accessToken, { currentPassword: FIXTURE_PASSWORD, newPassword: NEW_PASSWORD }).expect(204);

      await http(app).get(`${AUTH}/me`).set(bearer(current.accessToken)).expect(200);
      await http(app).get(`${AUTH}/me`).set(bearer(other.accessToken)).expect(401);
      await http(app).post(`${AUTH}/refresh`).send({ refreshToken: other.refreshToken }).expect(401);
      const revoked = await tenantDb.runAs(a.tenantId, (tx) => tx.session.findMany({ where: { userId: user.userId, revokedAt: { not: null } } }));
      expect(revoked.every((s) => s.revokedReason === 'password_changed')).toBe(true);
    });

    it('refuse avec 422 invalid_current_password, compte l’échec et audite sans mot de passe', async () => {
      const user = await newUser();

      const res = await change(user.token, { currentPassword: 'Mauvais-mot-de-passe-1', newPassword: NEW_PASSWORD }).expect(422);

      expect(res.body.code).toBe('invalid_current_password');
      const credential = await tenantDb.runAs(a.tenantId, (tx) => tx.userCredential.findFirstOrThrow({ where: { userId: user.userId } }));
      expect(credential.failedAttempts).toBe(1);
      const log = await tenantDb.runAs(a.tenantId, (tx) => tx.auditLog.findFirstOrThrow({ where: { action: 'auth.password.change_failed', resourceId: user.userId } }));
      expect(log.outcome).toBe('failure');
      expect(JSON.stringify(log.changes)).not.toContain('Mauvais');
      await postLogin(app, a.slug, user.email).expect(200);
    });

    it('verrouille le compte après des tentatives répétées de deviner le mot de passe actuel', async () => {
      const user = await newUser();

      for (let i = 0; i < 5; i += 1) await change(user.token, { currentPassword: `Faux-mot-de-passe-${i}`, newPassword: NEW_PASSWORD }).expect(422);

      await postLogin(app, a.slug, user.email).expect(401);
    });

    it('refuse avec 422 un nouveau mot de passe identique ou trop court', async () => {
      const user = await newUser();

      const same = await change(user.token, { currentPassword: FIXTURE_PASSWORD, newPassword: FIXTURE_PASSWORD }).expect(422);
      await change(user.token, { currentPassword: FIXTURE_PASSWORD, newPassword: 'court' }).expect(422);
      await change(user.token, { currentPassword: FIXTURE_PASSWORD }).expect(422);

      expect(same.body.code).toBe('password_unchanged');
    });

    it('exige une authentification (401) et n’agit que sur l’utilisateur courant', async () => {
      const mine = await newUser();
      const theirs = await newUser(b);

      await http(app).post(`${AUTH}/password/change`).set('X-Forwarded-For', distinctClientIp()).send({ currentPassword: FIXTURE_PASSWORD, newPassword: NEW_PASSWORD }).expect(401);
      await change(mine.token, { currentPassword: FIXTURE_PASSWORD, newPassword: NEW_PASSWORD, userId: theirs.userId }).expect(204);

      await postLogin(app, b.slug, theirs.email, FIXTURE_PASSWORD).expect(200);
    });

    it('audite le changement sans mot de passe', async () => {
      const user = await newUser();
      await change(user.token, { currentPassword: FIXTURE_PASSWORD, newPassword: NEW_PASSWORD }).expect(204);

      const log = await tenantDb.runAs(a.tenantId, (tx) => tx.auditLog.findFirstOrThrow({ where: { action: 'auth.password.changed', resourceId: user.userId } }));

      expect(log.actorUserId).toBe(user.userId);
      expect(JSON.stringify(log.changes)).not.toContain(NEW_PASSWORD);
    });
  });
});
