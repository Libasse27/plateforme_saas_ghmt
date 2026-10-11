import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BackgroundTasks } from '../../src/common/tasks/background-tasks';
import { PlatformDb } from '../../src/infrastructure/prisma/platform-db.service';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { LoginDelayService } from '../../src/modules/auth/services/login-delay.service';
import { AUTH, TEST_USER_AGENT, bearer, http, memoryMailer, postLogin } from '../auth/auth-helpers';
import { FIXTURE_PASSWORD, createTenantFixture, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { createClockOverrides } from '../notifications/notification-fixtures';

const BAD = 'mauvais-mot-de-passe';
const SECOND_MS = 1_000;
/** Plage publique déclarée comme réseau de l'établissement (les plages privées ne sont pas des réseaux de confiance). */
const TRUSTED_CIDR = '41.82.200.0/24';
const TRUSTED_IP = '41.82.200.17';
const OUTSIDE_IP = '41.82.201.17';
const DELAYS_BEFORE_TENTH = [0, 0, 0, 0, 30, 60, 120, 300, 600];

describe('auth : délai progressif de connexion (docs/11 D3)', () => {
  let app: INestApplication;
  let clock: ReturnType<typeof createClockOverrides>['clock'];
  let tenant: TenantFixture;

  const advance = (seconds: number) => clock.set(new Date(clock.now().getTime() + seconds * SECOND_MS));
  const failTimes = async (slug: string, email: string, times: number) => {
    for (let i = 0; i < times; i += 1) await postLogin(app, slug, email, BAD).expect(401);
  };
  const newUser = (role = 'cashier'): Promise<UserFixture> => createUserWithRole(app, tenant, role);
  const loginFrom = (ip: string, email: string, password: string = FIXTURE_PASSWORD) =>
    http(app).post(`${AUTH}/login`).set('X-Forwarded-For', ip).set('User-Agent', TEST_USER_AGENT).send({ tenantSlug: tenant.slug, email, password });
  /** Dix échecs consécutifs espacés juste au-delà de chaque palier (aucun refus `login_delayed`). */
  const failTenTimes = async (email: string) => {
    for (let i = 0; i < 10; i += 1) {
      await postLogin(app, tenant.slug, email, BAD).expect(401);
      if (i < 9) advance((DELAYS_BEFORE_TENTH[i] ?? 0) + 1);
    }
    await app.get(BackgroundTasks).drain();
  };
  const delayAlertsFor = (userId: string) =>
    app.get(TenantDb).runAs(tenant.tenantId, (tx) =>
      tx.notification.findMany({ where: { typeCode: 'security.login_delay_alert', context: { path: ['targetUserId'], equals: userId } }, select: { recipientId: true, channel: true } }),
    );

  beforeAll(async () => {
    const clocks = createClockOverrides();
    clock = clocks.clock;
    app = await createTestApp({}, { providerOverrides: clocks.overrides });
    tenant = await createTenantFixture(app, { prefix: 'delay' });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('n’impose aucun délai avant le 5e échec, puis répond 429 login_delayed avec Retry-After', async () => {
    const user = await newUser();
    await failTimes(tenant.slug, user.email, 5);

    const delayed = await postLogin(app, tenant.slug, user.email, BAD).expect(429);

    expect(delayed.body.code).toBe('login_delayed');
    expect(delayed.headers['retry-after']).toBe('30');
    expect(delayed.body.details).toEqual({ retryAfterSeconds: 30 });
    expect(delayed.body.detail).toBe('Trop de tentatives pour ce compte. Réessayez dans 30 secondes.');
  });

  it('renvoie une réponse identique pour un e-mail inexistant et pour un établissement inexistant', async () => {
    await failTimes(tenant.slug, 'fantome@nowhere.test', 5);
    await failTimes('etablissement-fantome', 'fantome@nowhere.test', 5);
    const user = await newUser();
    await failTimes(tenant.slug, user.email, 5);

    const unknownEmail = await postLogin(app, tenant.slug, 'fantome@nowhere.test', BAD).expect(429);
    const unknownTenant = await postLogin(app, 'etablissement-fantome', 'fantome@nowhere.test', BAD).expect(429);
    const real = await postLogin(app, tenant.slug, user.email, BAD).expect(429);

    const shape = (res: { body: Record<string, unknown>; headers: Record<string, unknown> }) => ({
      status: res.body['status'],
      code: res.body['code'],
      detail: res.body['detail'],
      details: res.body['details'],
      retryAfter: res.headers['retry-after'],
    });
    expect(shape(unknownEmail)).toEqual(shape(real));
    expect(shape(unknownTenant)).toEqual(shape(real));
  });

  it('refuse le bon mot de passe pendant le délai, puis l’accepte après et remet le compteur à zéro', async () => {
    const user = await newUser();
    await failTimes(tenant.slug, user.email, 5);

    await postLogin(app, tenant.slug, user.email).expect(429);
    advance(31);
    await postLogin(app, tenant.slug, user.email).expect(200);

    // Compteur remis à zéro : quatre nouveaux échecs ne déclenchent aucun délai.
    await failTimes(tenant.slug, user.email, 4);
    await postLogin(app, tenant.slug, user.email).expect(200);
  });

  it('allonge le délai aux échecs suivants (60 s au 6e) et le décompte depuis le dernier échec', async () => {
    const user = await newUser();
    await failTimes(tenant.slug, user.email, 5);
    advance(31);
    await postLogin(app, tenant.slug, user.email, BAD).expect(401);

    const delayed = await postLogin(app, tenant.slug, user.email).expect(429);

    expect(delayed.headers['retry-after']).toBe('60');
    advance(40);
    expect((await postLogin(app, tenant.slug, user.email).expect(429)).headers['retry-after']).toBe('20');
  });

  it('oublie les échecs 24 h après le dernier', async () => {
    const user = await newUser();
    await failTimes(tenant.slug, user.email, 5);
    advance(24 * 3_600 + 1);

    await postLogin(app, tenant.slug, user.email).expect(200);
  });

  it('POST /iam/users/{id}/unlock efface le compteur de délai', async () => {
    const user = await newUser();
    await failTimes(tenant.slug, user.email, 5);
    await postLogin(app, tenant.slug, user.email).expect(429);

    await http(app).post(`/api/v1/iam/users/${user.userId}/unlock`).set(bearer(tenant.adminToken)).send({ reason: 'Identité vérifiée par rappel téléphonique.' }).expect(200);

    await postLogin(app, tenant.slug, user.email).expect(200);
  });

  it('incrémente failed_attempts sans jamais écrire locked_until, et audite sans le motif « locked »', async () => {
    const user = await newUser();
    await failTimes(tenant.slug, user.email, 3);

    const credential = await app.get(TenantDb).runAs(tenant.tenantId, (tx) =>
      tx.userCredential.findUniqueOrThrow({ where: { tenantId_userId: { tenantId: tenant.tenantId, userId: user.userId } } }),
    );
    const audits = await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.auditLog.findMany({ where: { action: 'auth.login.failed', actorUserId: user.userId } }));

    expect(credential).toMatchObject({ failedAttempts: 3, lockedUntil: null });
    expect(audits).toHaveLength(3);
    for (const row of audits) expect(row.changes).toEqual({ reason: 'bad_password', delayed: false });
  });

  it('envoie un e-mail « tentatives inhabituelles » au 10e échec, une seule fois par 24 h', async () => {
    const user = await newUser();
    memoryMailer(app).clear();
    const delays = [0, 0, 0, 0, 30, 60, 120, 300, 600];
    for (let i = 0; i < 10; i += 1) {
      await postLogin(app, tenant.slug, user.email, BAD).expect(401);
      if (i < 9) advance((delays[i] ?? 0) + 1);
    }
    await app.get(BackgroundTasks).drain();

    const alerts = memoryMailer(app).sent.filter((m) => m.to === user.email);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.text).toContain('/mot-de-passe-oublie');
    const audits = await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.auditLog.findMany({ where: { action: 'auth.login.suspicious_activity_notified' } }));
    expect(audits.filter((a) => a.resourceId === user.userId)).toHaveLength(1);

    advance(901);
    await postLogin(app, tenant.slug, user.email, BAD).expect(401);
    await app.get(BackgroundTasks).drain();
    expect(memoryMailer(app).sent.filter((m) => m.to === user.email)).toHaveLength(1);
  });

  describe('réseau de confiance, audit et alerte (docs/11 décision 21)', () => {
    beforeAll(async () => {
      await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.trustedNetwork.create({ data: { tenantId: tenant.tenantId, network: TRUSTED_CIDR, label: 'Hôpital' } }));
    });

    it('plafonne le délai à 60 s depuis le réseau de l’établissement ; ailleurs le barème est inchangé', async () => {
      const user = await newUser();
      for (let i = 0; i < 8; i += 1) await app.get(LoginDelayService).recordFailure(tenant.slug, user.email, clock.now());

      const onSite = await loginFrom(TRUSTED_IP, user.email).expect(429);
      const elsewhere = await loginFrom(OUTSIDE_IP, user.email).expect(429);

      expect(onSite.headers['retry-after']).toBe('60');
      expect(elsewhere.headers['retry-after']).toBe('300');
      advance(61);
      await loginFrom(TRUSTED_IP, user.email).expect(200);
    });

    it('audite les refus login_delayed (auth.login.delayed), au plus un par compte et par heure', async () => {
      const user = await newUser();
      await failTimes(tenant.slug, user.email, 5);
      for (let i = 0; i < 3; i += 1) await postLogin(app, tenant.slug, user.email, BAD).expect(429);
      await app.get(BackgroundTasks).drain();
      const delayedAudits = () => app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.auditLog.findMany({ where: { action: 'auth.login.delayed', actorUserId: user.userId } }));

      const first = await delayedAudits();
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({ outcome: 'denied', resourceType: 'user', resourceId: user.userId });

      advance(3_601);
      await postLogin(app, tenant.slug, user.email, BAD).expect(401);
      await postLogin(app, tenant.slug, user.email, BAD).expect(429);
      await app.get(BackgroundTasks).drain();
      expect(await delayedAudits()).toHaveLength(2);
    });

    it('n’audite aucun refus pour un compte inexistant', async () => {
      const ghost = `fantome-${Date.now()}@nowhere.test`;
      await failTimes(tenant.slug, ghost, 5);
      await postLogin(app, tenant.slug, ghost, BAD).expect(429);
      await app.get(BackgroundTasks).drain();

      const audits = await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.auditLog.count({ where: { action: 'auth.login.delayed', actorType: 'anonymous' } }));
      expect(audits).toBe(0);
    });

    it('prévient les administrateurs (security.login_delay_alert) au 10e échec, jamais le compte visé', async () => {
      const user = await newUser();

      await failTenTimes(user.email);

      const alerts = await delayAlertsFor(user.userId);
      expect(alerts.map((a) => a.recipientId)).toContain(tenant.adminUserId);
      expect(alerts.map((a) => a.recipientId)).not.toContain(user.userId);
      expect(new Set(alerts.map((a) => a.channel))).toEqual(new Set(['email', 'inapp']));
      const audit = await app.get(TenantDb).runAs(tenant.tenantId, (tx) =>
        tx.auditLog.findFirstOrThrow({ where: { action: 'auth.login.suspicious_activity_notified', resourceId: user.userId } }),
      );
      expect(audit.changes).toMatchObject({ notifiedAdministrators: expect.any(Number) });
    });

    it('n’envoie aucune alerte pour un compte désactivé', async () => {
      const user = await newUser();
      await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.user.update({ where: { tenantId_id: { tenantId: tenant.tenantId, id: user.userId } }, data: { status: 'disabled' } }));
      memoryMailer(app).clear();

      await failTenTimes(user.email);

      expect(memoryMailer(app).sent.filter((m) => m.to === user.email)).toHaveLength(0);
      expect(await delayAlertsFor(user.userId)).toHaveLength(0);
    });
  });

  describe('établissement non confirmé (pending)', () => {
    let pending: TenantFixture;

    beforeAll(async () => {
      pending = await createTenantFixture(app, { prefix: 'pending' });
      await app.get(PlatformDb).run((tx) => tx.tenant.update({ where: { id: pending.tenantId }, data: { status: 'pending' } }));
    });

    it('répond 403 email_verification_required avec le bon mot de passe', async () => {
      const res = await postLogin(app, pending.slug, pending.adminEmail).expect(403);

      expect(res.body.code).toBe('email_verification_required');
      expect(res.body.detail).toBe('Confirmez l’adresse e-mail de l’administrateur pour activer l’établissement.');
    });

    it('reste une 401 générique avec un mauvais mot de passe', async () => {
      const res = await postLogin(app, pending.slug, pending.adminEmail, BAD).expect(401);

      expect(res.body.code).toBe('invalid_credentials');
    });

    it('n’ouvre aucune session', async () => {
      const successes = await app.get(TenantDb).runAs(pending.tenantId, (tx) => tx.auditLog.count({ where: { action: 'auth.login.success' } }));

      expect(successes).toBe(0);
    });
  });

  it('connexion réussie : /auth/me répond et le mot de passe de fixture reste valable', async () => {
    const user = await newUser();
    const login = await postLogin(app, tenant.slug, user.email, FIXTURE_PASSWORD).expect(200);

    await http(app).get(`${AUTH}/me`).set(bearer(login.body.data.accessToken)).expect(200);
  });
});
