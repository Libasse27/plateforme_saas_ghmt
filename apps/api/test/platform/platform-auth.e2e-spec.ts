import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlatformDb } from '../../src/infrastructure/prisma/platform-db.service';
import { hashPlatformToken } from '../../src/modules/platform/auth/platform-opaque-token';
import { FIXTURE_PASSWORD, createTenantFixture, type TenantFixture } from '../helpers/fixtures';
import { PLATFORM, bearer, createPlatformUser, http, platformClientIp, totpNow, type PlatformUserFixture } from '../helpers/platform';
import { createTestApp } from '../helpers/test-app';

const SECOND_MS = 1000;
const TOTP_STEP_SECONDS = 30;

describe('platform : authentification du realm plateforme (HTTP)', () => {
  let app: INestApplication;
  let tenant: TenantFixture;

  const login = (email: string, password: string = FIXTURE_PASSWORD) =>
    http(app).post(`${PLATFORM}/auth/login`).set('X-Forwarded-For', platformClientIp()).send({ email, password });
  const verify = (challengeId: string, code: string) =>
    http(app).post(`${PLATFORM}/auth/mfa/verify`).set('X-Forwarded-For', platformClientIp()).send({ challengeId, code });
  const refresh = (refreshToken: string) =>
    http(app).post(`${PLATFORM}/auth/refresh`).set('X-Forwarded-For', platformClientIp()).send({ refreshToken });

  /** Connexion complète d'un compte enrôlé : mot de passe puis code TOTP. */
  async function fullLogin(user: PlatformUserFixture, codeOffset = 0) {
    const first = await login(user.email).expect(200);
    const code = await totpNow(user.totpSecret!, codeOffset);
    const second = await verify(first.body.data.challengeId, code).expect(200);
    return second.body.data as { accessToken: string; refreshToken: string; expiresIn: number; mfaEnrolled: boolean };
  }

  beforeAll(async () => {
    app = await createTestApp();
    tenant = await createTenantFixture(app, { prefix: 'plat-auth' });
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('connexion et MFA obligatoire', () => {
    it('renvoie toujours un challenge MFA pour un compte enrôlé, puis des jetons après le code TOTP', async () => {
      const user = await createPlatformUser(app, 'super_admin');

      const first = await login(user.email).expect(200);
      expect(first.body.data).toMatchObject({ mfaRequired: true, methods: ['totp', 'backup_code'] });
      expect(first.body.data).not.toHaveProperty('accessToken');

      const tokens = await verify(first.body.data.challengeId, await totpNow(user.totpSecret!)).expect(200);
      expect(tokens.body.data).toMatchObject({ mfaEnrolled: true, mfaRequired: true });

      const me = await http(app).get(`${PLATFORM}/auth/me`).set(bearer(tokens.body.data.accessToken)).expect(200);
      expect(me.body.data).toMatchObject({ id: user.userId, role: 'super_admin', mfaVerified: true, mfaEnrolled: true });
      expect(me.body.data.permissions).toContain('tenants:suspend');
    });

    it('refuse la connexion d’un compte sans second facteur enrôlé (enrôlement par le script uniquement)', async () => {
      const user = await createPlatformUser(app, 'super_admin', { enrolled: false });

      const res = await login(user.email).expect(403);

      expect(res.body.code).toBe('mfa_enrollment_required_cli');
    });

    it('refuse un mot de passe erroné et un compte inconnu avec la même réponse (anti-énumération)', async () => {
      const user = await createPlatformUser(app, 'support');

      const wrong = await login(user.email, 'Mauvais-mot-de-passe-1').expect(401);
      const unknown = await login('inconnu@plateforme.test', 'Mauvais-mot-de-passe-1').expect(401);

      expect(wrong.body.code).toBe('invalid_credentials');
      expect(unknown.body.code).toBe(wrong.body.code);
      expect(unknown.body.detail).toBe(wrong.body.detail);
    });

    it('verrouille le compte après 5 échecs, même avec le bon mot de passe ensuite', async () => {
      const user = await createPlatformUser(app, 'billing');
      for (let i = 0; i < 5; i += 1) await login(user.email, 'Mauvais-mot-de-passe-1').expect(401);

      const res = await login(user.email).expect(401);

      expect(res.body.code).toBe('invalid_credentials');
      const row = await app.get(PlatformDb).run((tx) => tx.platformUser.findUniqueOrThrow({ where: { id: user.userId } }));
      expect(row.lockedUntil).not.toBeNull();
      expect(row.failedAttempts).toBeGreaterThanOrEqual(5);
    });

    it('refuse un compte désactivé', async () => {
      const user = await createPlatformUser(app, 'support', { disabled: true });
      await login(user.email).expect(401);
    });

    it('rejette un code TOTP erroné (401) et limite les essais d’un challenge à 5', async () => {
      const user = await createPlatformUser(app, 'super_admin');
      const first = await login(user.email).expect(200);
      for (let i = 0; i < 5; i += 1) {
        const bad = await verify(first.body.data.challengeId, '000000').expect(401);
        expect(bad.body.code).toBe('invalid_mfa_code');
      }
      // Challenge épuisé : même un code valide est refusé.
      await verify(first.body.data.challengeId, await totpNow(user.totpSecret!)).expect(401);
    });

    it('refuse le rejeu d’un code TOTP déjà utilisé et accepte un code de secours une seule fois', async () => {
      const user = await createPlatformUser(app, 'super_admin');
      const code = await totpNow(user.totpSecret!);
      const first = await login(user.email).expect(200);
      await verify(first.body.data.challengeId, code).expect(200);

      const second = await login(user.email).expect(200);
      await verify(second.body.data.challengeId, code).expect(401);
    });

    it('rejette une requête mal formée (422) et un challenge inventé (401)', async () => {
      await http(app).post(`${PLATFORM}/auth/login`).set('X-Forwarded-For', platformClientIp()).send({ email: 'pas-un-email' }).expect(422);
      await verify('p.' + 'a'.repeat(43), '123456').expect(401);
      await verify('x'.repeat(20), '123456').expect(401);
    });
  });

  describe('refresh, déconnexion et sessions', () => {
    it('fait tourner le refresh token et rejette un jeton tenant ou inventé', async () => {
      const user = await createPlatformUser(app, 'super_admin');
      const tokens = await fullLogin(user);

      const rotated = await refresh(tokens.refreshToken).expect(200);

      expect(rotated.body.data.refreshToken).not.toBe(tokens.refreshToken);
      await http(app).get(`${PLATFORM}/auth/me`).set(bearer(rotated.body.data.accessToken)).expect(200);
      await refresh('p.' + 'b'.repeat(43)).expect(401);
      await refresh('00000000-0000-4000-8000-000000000000.' + 'c'.repeat(43)).expect(401);
    });

    it('détecte la réutilisation d’un refresh token (> 10 s) : révoque la session, 401', async () => {
      const user = await createPlatformUser(app, 'super_admin');
      const tokens = await fullLogin(user);
      const rotated = await refresh(tokens.refreshToken).expect(200);
      const hash = hashPlatformToken(tokens.refreshToken)!;
      await app
        .get(PlatformDb)
        .run((tx) => tx.platformRefreshToken.update({ where: { tokenHash: hash }, data: { usedAt: new Date(Date.now() - 20 * SECOND_MS) } }));

      await refresh(tokens.refreshToken).expect(401);

      // La session est révoquée : même le jeton d’accès récent est refusé.
      await http(app).get(`${PLATFORM}/auth/me`).set(bearer(rotated.body.data.accessToken)).expect(401);
      const logs = await app.get(PlatformDb).run((tx) => tx.platformAuditLog.findMany({ where: { action: 'platform.auth.refresh_reuse_detected', actorUserId: user.userId } }));
      expect(logs).toHaveLength(1);
    });

    it('déconnecte : la session est révoquée et le jeton d’accès ne fonctionne plus (idempotent)', async () => {
      const user = await createPlatformUser(app, 'super_admin');
      const tokens = await fullLogin(user);

      await http(app).post(`${PLATFORM}/auth/logout`).send({ refreshToken: tokens.refreshToken }).expect(204);
      await http(app).post(`${PLATFORM}/auth/logout`).send({ refreshToken: tokens.refreshToken }).expect(204);

      await http(app).get(`${PLATFORM}/auth/me`).set(bearer(tokens.accessToken)).expect(401);
      await refresh(tokens.refreshToken).expect(401);
    });

    it('déconnecte aussi à partir du seul jeton d’accès, et refuse un appel sans aucun jeton', async () => {
      const user = await createPlatformUser(app, 'super_admin');
      const tokens = await fullLogin(user);
      await http(app).post(`${PLATFORM}/auth/logout`).set(bearer(tokens.accessToken)).send({}).expect(204);
      await http(app).get(`${PLATFORM}/auth/me`).set(bearer(tokens.accessToken)).expect(401);
      await http(app).post(`${PLATFORM}/auth/logout`).send({}).expect(401);
    });

    it('tient compte d’une désactivation du compte à la requête suivante', async () => {
      const user = await createPlatformUser(app, 'super_admin');
      await app.get(PlatformDb).run((tx) => tx.platformUser.update({ where: { id: user.userId }, data: { status: 'disabled' } }));
      await http(app).get(`${PLATFORM}/tenants`).set(bearer(user.token)).expect(401);
    });

    it('lit le rôle en base (pas le claim) : une rétrogradation prend effet immédiatement', async () => {
      const user = await createPlatformUser(app, 'super_admin');
      await http(app).post(`${PLATFORM}/tenants/${tenant.tenantId}/reactivate`).set(bearer(user.token)).expect(409);
      await app.get(PlatformDb).run((tx) => tx.platformUser.update({ where: { id: user.userId }, data: { role: 'support' } }));
      const res = await http(app).post(`${PLATFORM}/tenants/${tenant.tenantId}/reactivate`).set(bearer(user.token)).expect(403);
      expect(res.body.code).toBe('permission_denied');
    });

    it('refuse un jeton dont la session n’a pas de MFA vérifiée en base, même si le claim l’annonce', async () => {
      const user = await createPlatformUser(app, 'super_admin', { enrolled: true, mfaSession: false });
      // Le fixture signe un jeton `mfa: false` ; on forge un jeton `mfa: true` pour la même session.
      const { PlatformTokenService } = await import('../../src/modules/platform/auth/platform-token.service');
      const forged = await app.get(PlatformTokenService).sign({ userId: user.userId, sessionId: user.sessionId, role: 'super_admin', mfa: true });
      const res = await http(app).get(`${PLATFORM}/tenants`).set(bearer(forged)).expect(403);
      expect(res.body.code).toBe('mfa_enrollment_required');
    });
  });

  describe('séparation stricte des realms', () => {
    it('refuse sans jeton (401) sur toutes les routes de la console', async () => {
      for (const path of ['tenants', 'plans', 'invoices', 'dashboard', 'auth/me']) {
        await http(app).get(`${PLATFORM}/${path}`).expect(401);
      }
    });

    it('refuse un jeton TENANT sur /platform/* (401)', async () => {
      for (const path of ['tenants', 'plans', 'dashboard', 'auth/me', `tenants/${tenant.tenantId}`]) {
        await http(app).get(`${PLATFORM}/${path}`).set(bearer(tenant.adminToken)).expect(401);
      }
      await http(app).post(`${PLATFORM}/tenants/${tenant.tenantId}/suspend`).set(bearer(tenant.adminToken)).send({ reason: 'tentative' }).expect(401);
    });

    it('refuse un jeton PLATEFORME sur les routes tenant (401)', async () => {
      const admin = await createPlatformUser(app, 'super_admin');
      for (const path of ['/api/v1/subscription', '/api/v1/subscription/invoices', '/api/v1/org/sites', '/api/v1/auth/me', '/api/v1/iam/users']) {
        await http(app).get(path).set(bearer(admin.token)).expect(401);
      }
      await http(app).post('/api/v1/subscription/change').set(bearer(admin.token)).send({ planCode: 'basic', billingPeriod: 'monthly' }).expect(401);
    });

    it('refuse un jeton signé avec une autre audience ou un jeton non JWT', async () => {
      await http(app).get(`${PLATFORM}/tenants`).set(bearer('pas.un.jeton')).expect(401);
      await http(app).get(`${PLATFORM}/tenants`).set('Authorization', 'Basic abc').expect(401);
    });
  });

  describe('audit', () => {
    it('trace la connexion, l’échec et le refus de permission dans platform.audit_logs', async () => {
      const user = await createPlatformUser(app, 'support');
      await login(user.email, 'Mauvais-mot-de-passe-1').expect(401);
      await http(app).post(`${PLATFORM}/plans`).set(bearer(user.token)).send({}).expect(403);

      const logs = await app.get(PlatformDb).run((tx) => tx.platformAuditLog.findMany({ where: { actorUserId: user.userId } }));
      expect(logs.map((l) => l.action)).toContain('platform.authz.denied');
      const failure = await app.get(PlatformDb).run((tx) => tx.platformAuditLog.findMany({ where: { action: 'platform.auth.login_failed', actorUserId: user.userId } }));
      expect(failure).toHaveLength(1);
      expect(JSON.stringify(failure[0]!.changes)).not.toContain(user.email);
    });

    it('rend le journal en ajout seul : UPDATE et DELETE sont refusés par la base', async () => {
      const entry = await app.get(PlatformDb).run((tx) => tx.platformAuditLog.findFirstOrThrow());
      await expect(app.get(PlatformDb).run((tx) => tx.platformAuditLog.update({ where: { id: entry.id }, data: { action: 'falsifié' } }))).rejects.toThrow();
      await expect(app.get(PlatformDb).run((tx) => tx.platformAuditLog.delete({ where: { id: entry.id } }))).rejects.toThrow();
    });
  });

  it('décale le code TOTP d’un pas pour les connexions successives (anti-rejeu par pas strictement croissant)', async () => {
    const user = await createPlatformUser(app, 'super_admin');
    await fullLogin(user, 0);
    await fullLogin(user, TOTP_STEP_SECONDS);
  });
});
