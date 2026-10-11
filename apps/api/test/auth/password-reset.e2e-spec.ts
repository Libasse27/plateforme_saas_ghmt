import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BackgroundTasks } from '../../src/common/tasks/background-tasks';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { FIXTURE_PASSWORD, createTenantFixture, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { createClockOverrides } from '../notifications/notification-fixtures';
import { AUTH, bearer, distinctClientIp, enrollTotp, http, memoryMailer, postLogin, totpCode } from './auth-helpers';
import { traceStoreCallsInTransactions } from './transaction-trace';

const NEW_PASSWORD = 'Nouveau-mot-de-passe-2026';
const STEP = 30;
const TOKEN_IN_LINK = /\/reinitialiser\/([A-Za-z0-9._-]+)/;

describe('auth : mot de passe oublié et réinitialisation (docs/11 D8)', () => {
  let app: INestApplication;
  let clock: ReturnType<typeof createClockOverrides>['clock'];
  let tenant: TenantFixture;
  let other: TenantFixture;

  const forgot = (slug: string, email: string) => http(app).post(`${AUTH}/password/forgot`).set('X-Forwarded-For', distinctClientIp()).send({ tenantSlug: slug, email });
  const preview = (token: string) => http(app).post(`${AUTH}/password/reset/preview`).set('X-Forwarded-For', distinctClientIp()).send({ token });
  const reset = (token: string, body: Record<string, unknown> = {}) =>
    http(app).post(`${AUTH}/password/reset`).set('X-Forwarded-For', distinctClientIp()).send({ token, newPassword: NEW_PASSWORD, ...body });
  const drain = () => app.get(BackgroundTasks).drain();
  const mailsTo = (email: string) => memoryMailer(app).sent.filter((m) => m.to === email);
  const tokenFor = (email: string): string => {
    const message = memoryMailer(app).lastTo(email);
    const token = message ? TOKEN_IN_LINK.exec(message.text)?.[1] : undefined;
    if (!token) throw new Error('Jeton de réinitialisation introuvable');
    return token;
  };
  /** Demande + récupération du jeton dans l'e-mail. */
  const requestToken = async (user: { email: string }): Promise<string> => {
    await forgot(tenant.slug, user.email).expect(202);
    await drain();
    return tokenFor(user.email);
  };
  const newUser = (role = 'cashier'): Promise<UserFixture> => createUserWithRole(app, tenant, role);

  beforeAll(async () => {
    const clocks = createClockOverrides();
    clock = clocks.clock;
    app = await createTestApp({}, { providerOverrides: clocks.overrides });
    [tenant, other] = await Promise.all([createTenantFixture(app, { prefix: 'reset' }), createTenantFixture(app, { prefix: 'reset-b' })]);
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('POST /auth/password/forgot', () => {
    it('répond 202 identique pour compte éligible, e-mail inconnu, invité, désactivé et établissement inconnu ; e-mail pour l’éligible seulement', async () => {
      const eligible = await newUser();
      const disabled = await newUser();
      await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.user.update({ where: { tenantId_id: { tenantId: tenant.tenantId, id: disabled.userId } }, data: { status: 'disabled' } }));
      const invitedEmail = `invite-${Date.now()}@${tenant.slug}.test`;
      await http(app).post('/api/v1/iam/users').set(bearer(tenant.adminToken)).send({ fullName: 'Invité Test', email: invitedEmail, roleAssignments: [] }).expect(201);
      memoryMailer(app).clear();

      const responses = await Promise.all([
        forgot(tenant.slug, eligible.email),
        forgot(tenant.slug, 'inconnu@nowhere.test'),
        forgot(tenant.slug, invitedEmail),
        forgot(tenant.slug, disabled.email),
        forgot('etablissement-fantome', eligible.email),
      ]);
      await drain();

      const shape = (res: (typeof responses)[number]) => ({ status: res.status, data: res.body.data, code: res.body.code ?? null, success: res.body.success });
      for (const res of responses) expect(shape(res)).toEqual({ status: 202, data: { accepted: true }, code: null, success: true });
      expect(mailsTo(eligible.email)).toHaveLength(1);
      expect(mailsTo('inconnu@nowhere.test')).toHaveLength(0);
      expect(mailsTo(invitedEmail)).toHaveLength(0);
      expect(mailsTo(disabled.email)).toHaveLength(0);
      expect(memoryMailer(app).sent).toHaveLength(1);
    });

    it('envoie un lien /reinitialiser/<jeton> avec le code établissement, sans que le jeton ne soit stocké en clair', async () => {
      const user = await newUser();
      const token = await requestToken(user);

      const message = memoryMailer(app).lastTo(user.email)!;
      expect(message.text).toContain(`/reinitialiser/${token}`);
      expect(message.text).toContain(tenant.slug);
      expect(message.text).toContain('30 minutes');
      const rows = await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.passwordResetToken.findMany({ where: { userId: user.userId } }));
      expect(rows).toHaveLength(1);
      expect(Buffer.from(rows[0]!.tokenHash).toString('utf8')).not.toContain(token.split('.')[1]);
      const audits = await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.auditLog.findMany({ where: { action: 'auth.password.reset_requested', actorUserId: user.userId } }));
      expect(audits).toHaveLength(1);
    });

    it('invalide le jeton précédent à une nouvelle demande faite plus de 10 minutes après', async () => {
      const user = await newUser();
      const first = await requestToken(user);
      clock.set(new Date(clock.now().getTime() + 10 * 60_000 + 1_000));
      const second = await requestToken(user);
      clock.reset();

      expect(second).not.toBe(first);
      await reset(first).expect(410);
      await reset(second).expect(204);
    });

    it('ne touche pas à un jeton émis il y a moins de 10 minutes et n’envoie aucun nouvel e-mail (docs/11 §14.2 M2)', async () => {
      const user = await newUser();
      const first = await requestToken(user);
      clock.set(new Date(clock.now().getTime() + 9 * 60_000));
      await forgot(tenant.slug, user.email).expect(202);
      await drain();
      clock.reset();

      expect(mailsTo(user.email)).toHaveLength(1);
      const audits = await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.auditLog.count({ where: { action: 'auth.password.reset_requested', actorUserId: user.userId } }));
      expect(audits).toBe(1);
      await reset(first).expect(204);
    });

    it('valide le corps (422)', async () => {
      await http(app).post(`${AUTH}/password/forgot`).send({ tenantSlug: 'X', email: 'pas-un-email' }).expect(422);
    });
  });

  describe('POST /auth/password/reset/preview', () => {
    it('renvoie l’e-mail masqué, le code établissement et l’exigence du second facteur', async () => {
      const user = await newUser();
      const token = await requestToken(user);

      const res = await preview(token).expect(200);

      expect(res.body.data).toEqual({ tenantSlug: tenant.slug, emailMasked: expect.stringMatching(/\*\*\*/), mfaRequired: false });
      expect(res.body.data.emailMasked).not.toBe(user.email);
    });

    it('répond 410 reset_token_invalid pour un jeton inconnu, mal formé ou d’un autre établissement', async () => {
      const user = await newUser();
      const token = await requestToken(user);
      const crossTenant = `${other.tenantId}.${token.split('.')[1]}`;

      expect((await preview(crossTenant).expect(410)).body.code).toBe('reset_token_invalid');
      expect((await preview(`${tenant.tenantId}.${'a'.repeat(43)}`).expect(410)).body.code).toBe('reset_token_invalid');
      await preview('court').expect(422);
    });
  });

  describe('POST /auth/password/reset', () => {
    it('refuse un jeton expiré (31 minutes) puis consommé', async () => {
      const expiring = await newUser();
      const expiredToken = await requestToken(expiring);
      clock.set(new Date(clock.now().getTime() + 31 * 60_000));
      await reset(expiredToken).expect(410);
      await preview(expiredToken).expect(410);
      clock.reset();

      const user = await newUser();
      const token = await requestToken(user);
      await reset(token).expect(204);
      const replay = await reset(token).expect(410);
      expect(replay.body.code).toBe('reset_token_invalid');
    });

    it('une seule de deux requêtes concurrentes réussit', async () => {
      const user = await newUser();
      const token = await requestToken(user);

      const results = await Promise.all([reset(token), reset(token, { newPassword: 'Autre-mot-de-passe-2026' })]);

      expect(results.map((r) => r.status).sort()).toEqual([204, 410]);
    });

    it('révoque toutes les sessions, remet le compteur à zéro, confirme par e-mail sans lien et n’ouvre aucune session', async () => {
      const user = await newUser();
      const otherSession = await postLogin(app, tenant.slug, user.email).expect(200);
      await postLogin(app, tenant.slug, user.email, 'mauvais-mot-de-passe').expect(401);
      const token = await requestToken(user);
      memoryMailer(app).clear();

      await reset(token).expect(204);
      await drain();

      await http(app).get(`${AUTH}/me`).set(bearer(otherSession.body.data.accessToken)).expect(401);
      await http(app).get(`${AUTH}/me`).set(bearer(user.token)).expect(401);
      await postLogin(app, tenant.slug, user.email, FIXTURE_PASSWORD).expect(401);
      await postLogin(app, tenant.slug, user.email, NEW_PASSWORD).expect(200);
      const confirmation = mailsTo(user.email);
      expect(confirmation).toHaveLength(1);
      expect(confirmation[0]!.text).not.toMatch(/reinitialiser\//);
      const db = app.get(TenantDb);
      const credential = await db.runAs(tenant.tenantId, (tx) => tx.userCredential.findUniqueOrThrow({ where: { tenantId_userId: { tenantId: tenant.tenantId, userId: user.userId } } }));
      expect(credential.mustChangePassword).toBe(false);
      const verified = await db.runAs(tenant.tenantId, (tx) => tx.user.findUniqueOrThrow({ where: { tenantId_id: { tenantId: tenant.tenantId, id: user.userId } } }));
      expect(verified.emailVerifiedAt).not.toBeNull();
      const audit = await db.runAs(tenant.tenantId, (tx) => tx.auditLog.findMany({ where: { action: 'auth.password.reset_completed', actorUserId: user.userId } }));
      expect(audit).toHaveLength(1);
      expect(audit[0]!.changes).toMatchObject({ revokedSessions: expect.any(Number) });
      expect(JSON.stringify(audit[0]!.changes)).not.toContain(token);
    });

    it('valide le corps (422) : mot de passe trop court', async () => {
      const user = await newUser();
      const token = await requestToken(user);

      await reset(token, { newPassword: 'court' }).expect(422);
      await reset(token).expect(204);
    });

    it('applique la limite par jeton (6 par 15 minutes) : 429 à la 7e tentative', async () => {
      const token = `${tenant.tenantId}.${'z'.repeat(43)}`;
      for (let i = 0; i < 6; i += 1) await reset(token).expect(410);

      const blocked = await reset(token).expect(429);

      expect(blocked.body.code).toBe('rate_limited');
    });
  });

  describe('avec un second facteur actif', () => {
    let user: UserFixture;
    let secret: string;
    let backupCodes: string[];

    beforeAll(async () => {
      user = await newUser('doctor');
      ({ secret, backupCodes } = await enrollTotp(app, user.token, user.email));
    });

    const rewindStep = () =>
      app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.mfaFactor.updateMany({ where: { userId: user.userId }, data: { lastUsedStep: BigInt(Math.floor(Date.now() / 1000 / STEP) - 10) } }));

    it('annonce mfaRequired à l’aperçu et exige le code (422 mfa_code_required sur mfaCode)', async () => {
      const token = await requestToken(user);

      expect((await preview(token).expect(200)).body.data.mfaRequired).toBe(true);
      const res = await reset(token).expect(422);
      expect(res.body.code).toBe('mfa_code_required');
      expect(res.body.errors).toEqual([expect.objectContaining({ path: 'mfaCode' })]);
      await rewindStep();
      await reset(token, { mfaCode: await totpCode(secret) }).expect(204);
    });

    it('accepte un code de secours une seule fois (retiré du lot)', async () => {
      const code = backupCodes[0]!;
      const token = await requestToken(user);
      await reset(token, { mfaCode: code }).expect(204);
      const second = await requestToken(user);

      const replay = await reset(second, { mfaCode: code }).expect(422);

      expect(replay.body.code).toBe('invalid_code');
      const factor = await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.mfaFactor.findFirstOrThrow({ where: { userId: user.userId } }));
      expect(factor.backupCodeHashes).toHaveLength(9);
    });

    it('brûle le jeton au 5e code faux, même ensuite avec le bon code', async () => {
      // Utilisateur dédié : la limite par identifiant (3 demandes par 15 minutes) est atteinte pour `user`.
      const burned = await newUser('doctor');
      const enrolled = await enrollTotp(app, burned.token, burned.email);
      const token = await requestToken(burned);
      for (let i = 0; i < 5; i += 1) await reset(token, { mfaCode: '000001' }).expect(422);

      await reset(token, { mfaCode: await totpCode(enrolled.secret, STEP) }).expect(410);

      const audits = await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.auditLog.findMany({ where: { action: 'auth.password.reset_failed', actorUserId: burned.userId }, orderBy: { chainSeq: 'asc' } }));
      expect(audits.map((a) => (a.changes as { reason: string }).reason).slice(-5)).toEqual(['invalid_mfa', 'invalid_mfa', 'invalid_mfa', 'invalid_mfa', 'token_burned']);
    });
  });

  describe('délai progressif commun (slug|email) sur le code de second facteur (docs/11 §14.2 H2)', () => {
    const BAD_PASSWORD = 'mauvais-mot-de-passe';
    const advance = (seconds: number) => clock.set(new Date(clock.now().getTime() + seconds * 1_000));
    const doctorWithTotp = async () => {
      const doctor = await newUser('doctor');
      return { ...doctor, ...(await enrollTotp(app, doctor.token, doctor.email)) };
    };

    it('cinq codes faux à la réinitialisation ralentissent la connexion : 429 login_delayed, même avec le bon mot de passe', async () => {
      const doctor = await doctorWithTotp();
      const token = await requestToken(doctor);
      for (let i = 0; i < 5; i += 1) await reset(token, { mfaCode: '000001' }).expect(422);

      const delayed = await postLogin(app, tenant.slug, doctor.email).expect(429);

      expect(delayed.body.code).toBe('login_delayed');
      expect(delayed.headers['retry-after']).toBe('30');
    });

    it('contrôle le délai avant la vérification du code : refus 429 même avec le bon code, sans consommer d’essai', async () => {
      const doctor = await doctorWithTotp();
      const token = await requestToken(doctor);
      for (let i = 0; i < 5; i += 1) await postLogin(app, tenant.slug, doctor.email, BAD_PASSWORD).expect(401);

      const delayed = await reset(token, { mfaCode: doctor.backupCodes[0]! }).expect(429);

      expect(delayed.body.code).toBe('login_delayed');
      expect(delayed.headers['retry-after']).toBe('30');
      const row = await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.passwordResetToken.findFirstOrThrow({ where: { userId: doctor.userId, consumedAt: null } }));
      expect(row.attempts).toBe(0);
      advance(31);
      await reset(token, { mfaCode: doctor.backupCodes[0]! }).expect(204);
    });

    it('n’appelle jamais le stockage de limitation dans une transaction', async () => {
      const doctor = await doctorWithTotp();
      const token = await requestToken(doctor);
      const trace = traceStoreCallsInTransactions(app);
      try {
        for (let i = 0; i < 5; i += 1) await reset(token, { mfaCode: '000001' }).expect(422);
        const second = await (async () => {
          advance(31);
          await forgot(tenant.slug, doctor.email).expect(202);
          await drain();
          return tokenFor(doctor.email);
        })();
        await reset(second, { mfaCode: '000001' }).expect(422);
        await reset(second, { mfaCode: doctor.backupCodes[0]! }).expect(429);
        advance(61);
        await reset(second, { mfaCode: doctor.backupCodes[0]! }).expect(204);

        expect(trace.calls).toEqual([]);
        expect(trace.all).toEqual(expect.arrayContaining(['admit', 'claimDelayedAudit', 'clear']));
      } finally {
        trace.restore();
      }
    });
  });
});
