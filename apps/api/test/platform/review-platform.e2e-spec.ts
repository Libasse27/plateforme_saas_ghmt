import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlatformDb } from '../../src/infrastructure/prisma/platform-db.service';
import { PlatformTokenService } from '../../src/modules/platform/auth/platform-token.service';
import { FIXTURE_PASSWORD, createTenantFixture } from '../helpers/fixtures';
import { PLATFORM, bearer, createPlatformUser, http, platformClientIp, totpNow } from '../helpers/platform';
import { createTestApp } from '../helpers/test-app';

const NEW_PASSWORD = 'Nouveau-mot-de-passe-2026!';

describe('platform : correctifs de la revue sécurité (M2, M7, L2)', () => {
  let app: INestApplication;

  const login = (email: string, password: string = FIXTURE_PASSWORD) =>
    http(app).post(`${PLATFORM}/auth/login`).set('X-Forwarded-For', platformClientIp()).send({ email, password });

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app?.close();
  });

  describe('M2 : un compte jamais enrôlé ne peut pas être pris par qui lit le mot de passe', () => {
    it('refuse la connexion sans MFA activée (403 mfa_enrollment_required_cli) et n’ouvre aucune session', async () => {
      const user = await createPlatformUser(app, 'super_admin', { enrolled: false });
      const before = await app.get(PlatformDb).run((tx) => tx.platformSession.count({ where: { userId: user.userId } }));

      const res = await login(user.email).expect(403);

      expect(res.body.code).toBe('mfa_enrollment_required_cli');
      expect(res.body.data?.accessToken).toBeUndefined();
      expect(await app.get(PlatformDb).run((tx) => tx.platformSession.count({ where: { userId: user.userId } }))).toBe(before);
      const logs = await app.get(PlatformDb).run((tx) => tx.platformAuditLog.findMany({ where: { action: 'platform.auth.login_refused', actorUserId: user.userId } }));
      expect(logs).toHaveLength(1);
    });

    it('un mauvais mot de passe reste un 401 identique pour un compte non enrôlé (aucune énumération)', async () => {
      const user = await createPlatformUser(app, 'super_admin', { enrolled: false });

      await login(user.email, 'mauvais-mot-de-passe-12').expect(401);
    });

    it('n’expose plus d’API web d’enrôlement TOTP (setup/activate supprimées : l’enrôlement se fait par le script)', async () => {
      const user = await createPlatformUser(app, 'super_admin');

      await http(app).post(`${PLATFORM}/auth/mfa/totp/setup`).set(bearer(user.token)).expect(404);
      await http(app).post(`${PLATFORM}/auth/mfa/totp/activate`).set(bearer(user.token)).send({ code: '123456' }).expect(404);
    });
  });

  describe('M7 : dérogations et plans non publics réservés au super_admin', () => {
    it('refuse les dérogations au rôle billing (403) mais les accepte pour super_admin', async () => {
      const tenant = await createTenantFixture(app, { prefix: 'm7-ovr', subscriptionPlan: 'trial' });
      const billing = await createPlatformUser(app, 'billing');
      const admin = await createPlatformUser(app, 'super_admin');
      const body = { planCode: 'standard', billingPeriod: 'monthly', overrides: { limits: { users: 40 } } };

      const denied = await http(app).post(`${PLATFORM}/subscriptions/${tenant.tenantId}/change`).set(bearer(billing.token)).send(body).expect(403);
      const allowed = await http(app).post(`${PLATFORM}/subscriptions/${tenant.tenantId}/change`).set(bearer(admin.token)).send(body).expect(200);

      expect(denied.body.code).toBe('super_admin_required');
      expect(allowed.body.data.subscription.entitlements.limits.users).toBe(40);
    });

    it('refuse un plan non public au rôle billing (403) et laisse le billing changer vers un plan public sans dérogation', async () => {
      const tenant = await createTenantFixture(app, { prefix: 'm7-priv', subscriptionPlan: 'trial' });
      const billing = await createPlatformUser(app, 'billing');
      const admin = await createPlatformUser(app, 'super_admin');
      await app.get(PlatformDb).run((tx) =>
        tx.plan.upsert({
          where: { code_version: { code: 'prive_m7', version: 1 } },
          update: {},
          create: {
            code: 'prive_m7', name: 'Privé M7', tier: 'standard', priceMonthly: '1000.00', priceYearly: '10000.00', currency: 'XOF', isPublic: false,
            entitlements: { modules: ['billing', 'cashier'], limits: { users: 3, sites: 1, appointmentsMonthly: 10, activePatients: 10, smsMonthly: 0, storageGb: 1 }, features: { customRoles: false, export: false, api: false } },
          },
        }),
      );

      const denied = await http(app).post(`${PLATFORM}/subscriptions/${tenant.tenantId}/change`).set(bearer(billing.token)).send({ planCode: 'prive_m7', billingPeriod: 'monthly' }).expect(403);
      const publicChange = await http(app).post(`${PLATFORM}/subscriptions/${tenant.tenantId}/change`).set(bearer(billing.token)).send({ planCode: 'basic', billingPeriod: 'monthly' }).expect(200);
      const adminChange = await http(app).post(`${PLATFORM}/subscriptions/${tenant.tenantId}/change`).set(bearer(admin.token)).send({ planCode: 'prive_m7', billingPeriod: 'monthly' }).expect(200);

      expect(denied.body.code).toBe('super_admin_required');
      expect(publicChange.body.data.effect).toBe('immediate');
      expect(adminChange.body.data.subscription.plan.code).toBe('prive_m7');
    });
  });

  describe('L2 : POST /platform/auth/password/change', () => {
    const change = (token: string, body: Record<string, unknown>) =>
      http(app).post(`${PLATFORM}/auth/password/change`).set(bearer(token)).send(body);

    it('change le mot de passe, révoque les autres sessions (pas la courante) et audite', async () => {
      const user = await createPlatformUser(app, 'super_admin');
      const other = await app.get(PlatformDb).run((tx) =>
        tx.platformSession.create({ data: { userId: user.userId, expiresAt: new Date(Date.now() + 3_600_000), mfaVerifiedAt: new Date() }, select: { id: true } }),
      );
      const otherToken = await app.get(PlatformTokenService).sign({ userId: user.userId, sessionId: other.id, role: 'super_admin', mfa: true });
      await http(app).get(`${PLATFORM}/auth/me`).set(bearer(otherToken)).expect(200);

      const res = await change(user.token, { currentPassword: FIXTURE_PASSWORD, newPassword: NEW_PASSWORD }).expect(200);

      expect(res.body.data).toEqual({ changed: true, revokedSessions: 1 });
      await http(app).get(`${PLATFORM}/auth/me`).set(bearer(otherToken)).expect(401);
      await http(app).get(`${PLATFORM}/auth/me`).set(bearer(user.token)).expect(200);
      await login(user.email, FIXTURE_PASSWORD).expect(401);
      const next = await login(user.email, NEW_PASSWORD).expect(200);
      expect(next.body.data.mfaRequired).toBe(true);
      expect(await totpNow(user.totpSecret!)).toMatch(/^\d{6}$/);
      const logs = await app.get(PlatformDb).run((tx) => tx.platformAuditLog.findMany({ where: { action: 'platform.auth.password_changed', actorUserId: user.userId } }));
      expect(logs).toHaveLength(1);
      expect(JSON.stringify(logs[0]!.changes)).not.toContain(NEW_PASSWORD);
    });

    it('refuse un mot de passe actuel erroné (403, audité), un nouveau identique ou trop court (422)', async () => {
      const user = await createPlatformUser(app, 'support');

      const wrong = await change(user.token, { currentPassword: 'mauvais-mot-de-passe-12', newPassword: NEW_PASSWORD }).expect(403);
      await change(user.token, { currentPassword: FIXTURE_PASSWORD, newPassword: FIXTURE_PASSWORD }).expect(422);
      await change(user.token, { currentPassword: FIXTURE_PASSWORD, newPassword: 'court' }).expect(422);

      expect(wrong.body.code).toBe('invalid_current_password');
      await login(user.email, FIXTURE_PASSWORD).expect(200);
    });

    it('exige un jeton (401) et une session MFA vérifiée (403)', async () => {
      const noMfa = await createPlatformUser(app, 'support', { enrolled: true, mfaSession: false });

      await http(app).post(`${PLATFORM}/auth/password/change`).send({ currentPassword: FIXTURE_PASSWORD, newPassword: NEW_PASSWORD }).expect(401);
      await change(noMfa.token, { currentPassword: FIXTURE_PASSWORD, newPassword: NEW_PASSWORD }).expect(403);
    });
  });

  describe('L1 : secret JWT dédié au realm plateforme', () => {
    it('refuse un jeton plateforme signé avec le secret des jetons tenant', async () => {
      const user = await createPlatformUser(app, 'super_admin');
      const { JwtService } = await import('@nestjs/jwt');
      const forged = await app.get(JwtService).signAsync(
        { sid: user.sessionId, realm: 'platform', role: 'super_admin', mfa: true },
        {
          subject: user.userId,
          algorithm: 'HS256',
          expiresIn: 300,
          issuer: process.env['JWT_ISSUER']!,
          audience: `${process.env['JWT_AUDIENCE']!}-platform`,
          secret: process.env['JWT_ACCESS_SECRET']!,
        },
      );

      await http(app).get(`${PLATFORM}/auth/me`).set(bearer(forged)).expect(401);
      await http(app).get(`${PLATFORM}/auth/me`).set(bearer(user.token)).expect(200);
    });
  });
});
