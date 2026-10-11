import type { INestApplication } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BackgroundTasks } from '../../src/common/tasks/background-tasks';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { AUTH, bearer, distinctClientIp, enrollTotp, http, loginOk, postLogin, postMfaVerify, totpCode } from '../auth/auth-helpers';
import { createTenantFixture, createUserWithRole, type TenantFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { createClockOverrides } from '../notifications/notification-fixtures';
import { traceStoreCallsInTransactions } from '../auth/transaction-trace';

const BAD = 'mauvais-mot-de-passe';
const WRONG_CODE = '000000';
const STEP = 30;

/**
 * Second facteur et changement de mot de passe dans le délai progressif (docs/11 §14.2 H2 et points mineurs) : un code faux
 * ou un mot de passe actuel faux compte comme un échec de connexion, et le délai est contrôlé en tête de chaque étape.
 */
describe('auth : délai progressif sur le second facteur et le mot de passe actuel', () => {
  let app: INestApplication;
  let clock: ReturnType<typeof createClockOverrides>['clock'];
  let tenant: TenantFixture;

  const advance = (seconds: number) => clock.set(new Date(clock.now().getTime() + seconds * 1_000));
  /** Utilisateur avec un TOTP actif (enrôlé par l'API) ; le pas courant est déjà consommé par l'activation. */
  const userWithTotp = async () => {
    const user = await createUserWithRole(app, tenant, 'cashier');
    const { secret, backupCodes } = await enrollTotp(app, (await loginOk(app, tenant, user.email)).accessToken, user.email);
    return { ...user, secret, backupCodes };
  };
  const challengeFor = async (email: string): Promise<string> => {
    const res = await postLogin(app, tenant.slug, email).expect(200);
    expect(res.body.data.mfaRequired).toBe(true);
    return res.body.data.challengeId as string;
  };

  beforeAll(async () => {
    const clocks = createClockOverrides();
    clock = clocks.clock;
    app = await createTestApp({}, { providerOverrides: clocks.overrides });
    tenant = await createTenantFixture(app, { prefix: 'mfadelay' });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('un mot de passe juste suivi d’un challenge ne compte pas comme un échec', async () => {
    const user = await userWithTotp();
    for (let i = 0; i < 6; i += 1) await challengeFor(user.email);

    await postMfaVerify(app, await challengeFor(user.email), user.backupCodes[0]!).expect(200);
  });

  it('cinq codes faux ralentissent la connexion : 429 login_delayed au login suivant, même avec le bon mot de passe', async () => {
    const user = await userWithTotp();
    const challengeId = await challengeFor(user.email);
    for (let i = 0; i < 5; i += 1) await postMfaVerify(app, challengeId, WRONG_CODE).expect(401);

    const delayed = await postLogin(app, tenant.slug, user.email).expect(429);

    expect(delayed.body.code).toBe('login_delayed');
    expect(delayed.headers['retry-after']).toBe('30');
  });

  it('contrôle le délai en tête de mfa/verify : un challenge ouvert est refusé pendant le délai, même avec le bon code', async () => {
    const user = await userWithTotp();
    const challengeId = await challengeFor(user.email);
    for (let i = 0; i < 5; i += 1) await postLogin(app, tenant.slug, user.email, BAD).expect(401);

    const delayed = await postMfaVerify(app, challengeId, await totpCode(user.secret, STEP)).expect(429);

    expect(delayed.body.code).toBe('login_delayed');
    advance(31);
    const verified = await postMfaVerify(app, challengeId, await totpCode(user.secret, STEP)).expect(200);
    await http(app).get(`${AUTH}/me`).set(bearer(verified.body.data.accessToken)).expect(200);
  });

  it('les codes faux répartis sur plusieurs challenges s’additionnent, et une réussite remet le compteur à zéro', async () => {
    const user = await userWithTotp();
    for (let i = 0; i < 4; i += 1) await postMfaVerify(app, await challengeFor(user.email), WRONG_CODE).expect(401);
    const last = await challengeFor(user.email);
    await postMfaVerify(app, last, user.backupCodes[0]!).expect(200);

    // Compteur remis à zéro : quatre nouveaux échecs ne ralentissent pas.
    for (let i = 0; i < 4; i += 1) await postLogin(app, tenant.slug, user.email, BAD).expect(401);
    await challengeFor(user.email);
  });

  it('audite le refus de mfa/verify (auth.login.delayed, source mfa)', async () => {
    const user = await userWithTotp();
    const challengeId = await challengeFor(user.email);
    for (let i = 0; i < 5; i += 1) await postMfaVerify(app, challengeId, WRONG_CODE).expect(401);
    const fresh = await (async () => {
      advance(31);
      return challengeFor(user.email);
    })();
    await postMfaVerify(app, fresh, WRONG_CODE).expect(401);
    await postMfaVerify(app, fresh, WRONG_CODE).expect(429);
    await app.get(BackgroundTasks).drain();

    const audits = await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.auditLog.findMany({ where: { action: 'auth.login.delayed', actorUserId: user.userId } }));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.changes).toMatchObject({ source: 'mfa' });
  });

  describe('POST /auth/password/change', () => {
    const change = (token: string, currentPassword: string) =>
      http(app)
        .post(`${AUTH}/password/change`)
        .set(bearer(token))
        .set('X-Forwarded-For', distinctClientIp())
        .send({ currentPassword, newPassword: 'Nouveau-mot-de-passe-2026' });

    it('un mot de passe actuel faux compte dans le délai : après cinq échecs, 429 login_delayed au changement et à la connexion', async () => {
      const user = await createUserWithRole(app, tenant, 'cashier');
      for (let i = 0; i < 5; i += 1) expect((await change(user.token, BAD).expect(422)).body.code).toBe('invalid_current_password');

      expect((await change(user.token, BAD).expect(429)).body.code).toBe('login_delayed');
      expect((await postLogin(app, tenant.slug, user.email).expect(429)).body.code).toBe('login_delayed');
    });

    it('invalide les jetons de réinitialisation en cours', async () => {
      const user = await createUserWithRole(app, tenant, 'cashier');
      const pending = await app.get(TenantDb).runAs(tenant.tenantId, (tx) =>
        tx.passwordResetToken.create({
          data: { tenantId: tenant.tenantId, userId: user.userId, tokenHash: new Uint8Array(32).fill(7), expiresAt: new Date(clock.now().getTime() + 30 * 60_000) },
          select: { id: true },
        }),
      );

      await change(user.token, 'Motdepasse-solide-2026').expect(204);

      const row = await app.get(TenantDb).runAs(tenant.tenantId, (tx) =>
        tx.passwordResetToken.findUniqueOrThrow({ where: { tenantId_id: { tenantId: tenant.tenantId, id: pending.id } }, select: { consumedAt: true } }),
      );
      expect(row.consumedAt).not.toBeNull();
    });
  });

  describe('stockage de limitation hors transaction Postgres (Redis lent ou en panne : aucune connexion immobilisée)', () => {
    let trace: ReturnType<typeof traceStoreCallsInTransactions> | undefined;
    const startTrace = () => {
      trace = traceStoreCallsInTransactions(app);
      return trace;
    };

    afterEach(() => {
      trace?.restore();
      trace = undefined;
    });

    it('mfa/verify : code faux, refus pendant le délai puis bon code, sans appel au stockage dans une transaction', async () => {
      const user = await userWithTotp();
      const challengeId = await challengeFor(user.email);
      const { calls } = startTrace();

      for (let i = 0; i < 5; i += 1) await postMfaVerify(app, challengeId, WRONG_CODE).expect(401);
      await postLogin(app, tenant.slug, user.email).expect(429);
      advance(31);
      const next = await challengeFor(user.email);
      await postMfaVerify(app, next, WRONG_CODE).expect(401);
      await postMfaVerify(app, next, user.backupCodes[0]!).expect(429);
      advance(61);
      await postMfaVerify(app, next, user.backupCodes[0]!).expect(200);

      expect(calls).toEqual([]);
    });

    it('mfa/verify : l’alerte du 10e échec n’est réservée qu’après le commit', async () => {
      const user = await userWithTotp();
      for (let i = 0; i < 9; i += 1) {
        advance(1_000);
        await postLogin(app, tenant.slug, user.email, BAD).expect(401);
      }
      advance(1_000);
      const challengeId = await challengeFor(user.email);
      const { calls, all } = startTrace();

      await postMfaVerify(app, challengeId, WRONG_CODE).expect(401);
      await app.get(BackgroundTasks).drain();

      expect(all.filter((method) => method === 'claimSuspiciousAlert')).toHaveLength(1);
      expect(calls).toEqual([]);
    });

    it('password/change : mot de passe actuel faux, juste, puis refus pendant le délai, sans appel au stockage dans une transaction', async () => {
      const user = await createUserWithRole(app, tenant, 'cashier');
      const change = (currentPassword: string, newPassword = 'Nouveau-mot-de-passe-2026') =>
        http(app).post(`${AUTH}/password/change`).set(bearer(user.token)).set('X-Forwarded-For', distinctClientIp()).send({ currentPassword, newPassword });
      const { calls } = startTrace();

      await change(BAD).expect(422);
      await change('Motdepasse-solide-2026').expect(204);
      for (let i = 0; i < 4; i += 1) await change(BAD).expect(422);
      await change(BAD).expect(429);

      expect(calls).toEqual([]);
    });

    it('connexion sans second facteur : remise à zéro du compteur après le commit', async () => {
      const user = await createUserWithRole(app, tenant, 'cashier');
      await postLogin(app, tenant.slug, user.email, BAD).expect(401);
      const { calls } = startTrace();

      await loginOk(app, tenant, user.email);

      expect(calls).toEqual([]);
    });
  });
});
