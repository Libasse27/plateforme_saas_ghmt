import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthTokenPurgeJob } from '../../src/modules/auth/jobs/auth-token-purge.job';
import { PURGE_BATCH_SIZE } from '../../src/modules/auth/jobs/purge-rules';
import { PlatformDb } from '../../src/infrastructure/prisma/platform-db.service';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { AUTH, bearer, http, postLogin } from '../auth/auth-helpers';
import { createTenantFixture, createUserWithRole, type TenantFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { DAY_MS, MINUTE_MS, createClockOverrides } from '../notifications/notification-fixtures';

const NOW = Date.now();
const ago = (ms: number): Date => new Date(NOW - ms);
const hash = (): Uint8Array<ArrayBuffer> => new Uint8Array(randomBytes(32));

describe('auth : purge planifiée des jetons (docs/11 D16) et lastSeenAt (D15)', () => {
  let app: INestApplication;
  let clock: ReturnType<typeof createClockOverrides>['clock'];
  let a: TenantFixture;
  let b: TenantFixture;

  const db = () => app.get(TenantDb);

  /** Lignes périmées et récentes pour chaque table purgée ; retourne les identifiants à conserver. */
  async function seed(tenant: TenantFixture): Promise<{ keep: Record<string, string[]>; drop: Record<string, string[]> }> {
    const { tenantId, adminUserId: userId } = tenant;
    return db().runAs(tenantId, async (tx) => {
      const session = (expiresAt: Date, revokedAt: Date | null = null) => tx.session.create({ data: { tenantId, userId, expiresAt, revokedAt }, select: { id: true } });
      const [active, expired, oldRevoked, recentRevoked] = await Promise.all([
        session(new Date(NOW + DAY_MS)),
        session(ago(40 * DAY_MS)),
        session(new Date(NOW + DAY_MS), ago(40 * DAY_MS)),
        session(new Date(NOW + DAY_MS), ago(5 * DAY_MS)),
      ]);
      const token = (expiresAt: Date) => tx.refreshToken.create({ data: { tenantId, sessionId: active.id, familyId: crypto.randomUUID(), tokenHash: hash(), expiresAt }, select: { id: true } });
      const challenge = (expiresAt: Date) => tx.mfaChallenge.create({ data: { tenantId, userId, tokenHash: hash(), expiresAt }, select: { id: true } });
      const emailCode = (expiresAt: Date) => tx.mfaEmailCode.create({ data: { tenantId, userId, sessionId: active.id, codeHash: hash(), expiresAt }, select: { id: true } });
      const invitation = (expiresAt: Date, consumedAt: Date | null) => tx.invitation.create({ data: { tenantId, userId, tokenHash: hash(), expiresAt, consumedAt }, select: { id: true } });
      const reset = (expiresAt: Date) => tx.passwordResetToken.create({ data: { tenantId, userId, tokenHash: hash(), expiresAt }, select: { id: true } });
      const ids = async (...rows: Promise<{ id: string }>[]) => (await Promise.all(rows)).map((r) => r.id);
      return {
        drop: {
          sessions: [expired.id, oldRevoked.id],
          refresh_tokens: await ids(token(ago(2 * DAY_MS))),
          mfa_challenges: await ids(challenge(ago(2 * DAY_MS))),
          mfa_email_codes: await ids(emailCode(ago(2 * DAY_MS))),
          invitations: await ids(invitation(ago(40 * DAY_MS), ago(40 * DAY_MS)), invitation(ago(40 * DAY_MS), null)),
          password_reset_tokens: await ids(reset(ago(2 * DAY_MS))),
        },
        keep: {
          sessions: [active.id, recentRevoked.id],
          refresh_tokens: await ids(token(ago(12 * 3_600_000)), token(new Date(NOW + DAY_MS))),
          mfa_challenges: await ids(challenge(ago(12 * 3_600_000))),
          mfa_email_codes: await ids(emailCode(ago(12 * 3_600_000))),
          invitations: await ids(invitation(ago(5 * DAY_MS), ago(5 * DAY_MS)), invitation(new Date(NOW + DAY_MS), null)),
          password_reset_tokens: await ids(reset(ago(12 * 3_600_000))),
        },
      };
    });
  }

  const present = (tenant: TenantFixture, table: string, ids: string[]): Promise<number> =>
    db().runAs(tenant.tenantId, async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM tenant.${table} WHERE id = ANY($1::uuid[])`, ids);
      return Number(rows[0]!.n);
    });

  beforeAll(async () => {
    const clocks = createClockOverrides();
    clock = clocks.clock;
    app = await createTestApp({}, { providerOverrides: clocks.overrides });
    [a, b] = await Promise.all([createTenantFixture(app, { prefix: 'purge-a' }), createTenantFixture(app, { prefix: 'purge-b' })]);
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('AuthTokenPurgeJob.runOnce', () => {
    it('supprime uniquement les lignes au-delà des seuils, par table, et ne touche pas aux autres établissements', async () => {
      const seededA = await seed(a);
      const seededB = await seed(b);

      const report = await app.get(AuthTokenPurgeJob).runOnce(new Date(NOW), { tenantIds: [a.tenantId] });

      for (const [table, ids] of Object.entries(seededA.drop)) expect(await present(a, table, ids), `${table} périmées`).toBe(0);
      for (const [table, ids] of Object.entries(seededA.keep)) expect(await present(a, table, ids), `${table} conservées`).toBe(ids.length);
      for (const [table, ids] of Object.entries({ ...seededB.drop })) expect(await present(b, table, ids), `${table} autre tenant`).toBe(ids.length);
      expect(report.every((entry) => entry.tenantId === a.tenantId)).toBe(true);
      expect(Object.fromEntries(report.map((e) => [e.table, e.deleted]))).toMatchObject({ sessions: 2, invitations: 2, password_reset_tokens: 1, mfa_challenges: 1, mfa_email_codes: 1 });
    });

    it('supprime en cascade les jetons d’une session purgée', async () => {
      const { tenantId, adminUserId: userId } = b;
      const sessionId = await db().runAs(tenantId, async (tx) => {
        const session = await tx.session.create({ data: { tenantId, userId, expiresAt: ago(45 * DAY_MS) }, select: { id: true } });
        await tx.refreshToken.create({ data: { tenantId, sessionId: session.id, familyId: crypto.randomUUID(), tokenHash: hash(), expiresAt: new Date(NOW + DAY_MS) } });
        return session.id;
      });

      await app.get(AuthTokenPurgeJob).runOnce(new Date(NOW), { tenantIds: [b.tenantId] });

      const left = await db().runAs(tenantId, (tx) => tx.refreshToken.count({ where: { sessionId } }));
      expect(left).toBe(0);
    });

    it(`plafonne à ${PURGE_BATCH_SIZE} lignes par table et par passe`, async () => {
      const total = PURGE_BATCH_SIZE + 3;
      await db().runAs(a.tenantId, (tx) =>
        tx.$executeRaw`
          INSERT INTO tenant.password_reset_tokens (id, tenant_id, user_id, token_hash, expires_at)
          SELECT gen_random_uuid(), ${a.tenantId}::uuid, ${a.adminUserId}::uuid, gen_random_bytes(32), now() - interval '3 days'
          FROM generate_series(1, ${total})`,
      );

      const first = await app.get(AuthTokenPurgeJob).runOnce(new Date(), { tenantIds: [a.tenantId] });
      const second = await app.get(AuthTokenPurgeJob).runOnce(new Date(), { tenantIds: [a.tenantId] });

      expect(first.find((e) => e.table === 'password_reset_tokens')!.deleted).toBe(PURGE_BATCH_SIZE);
      expect(second.find((e) => e.table === 'password_reset_tokens')!.deleted).toBeGreaterThanOrEqual(3);
    });

    it('couvre aussi les établissements résiliés (terminated, slug libéré, docs/11 §14.2 M7)', async () => {
      const closed = await createTenantFixture(app, { prefix: 'purge-term' });
      await app.get(PlatformDb).run((tx) => tx.tenant.update({ where: { id: closed.tenantId }, data: { status: 'terminated', deletedAt: new Date(NOW) } }));
      const { drop } = await seed(closed);

      const tenantIds = await app.get(AuthTokenPurgeJob).purgeableTenantIds();
      await app.get(AuthTokenPurgeJob).runOnce(new Date(NOW), { tenantIds: tenantIds.filter((id) => id === closed.tenantId) });

      expect(tenantIds).toContain(closed.tenantId);
      expect(tenantIds).toContain(a.tenantId);
      const remaining = await db().runAs(closed.tenantId, (tx) => tx.passwordResetToken.count({ where: { id: { in: drop['password_reset_tokens']! } } }));
      expect(remaining).toBe(0);
    });

    it('ne s’exécute jamais seul en test (SECURITY_JOBS_ENABLED=false)', async () => {
      const before = await db().runAs(a.tenantId, (tx) => tx.passwordResetToken.count());

      await app.get(AuthTokenPurgeJob).scheduledRun();

      expect(await db().runAs(a.tenantId, (tx) => tx.passwordResetToken.count())).toBe(before);
    });
  });

  describe('lastSeenAt', () => {
    const lastSeen = async (tenant: TenantFixture, userId: string): Promise<Date | null> =>
      (await db().runAs(tenant.tenantId, (tx) => tx.user.findUniqueOrThrow({ where: { tenantId_id: { tenantId: tenant.tenantId, id: userId } } }))).lastSeenAt;

    it('est renseigné à la connexion, puis inchangé en moins de 5 minutes, puis rafraîchi au-delà (login et refresh)', async () => {
      const user = await createUserWithRole(app, a, 'cashier');
      expect(await lastSeen(a, user.userId)).toBeNull();

      const first = await postLogin(app, a.slug, user.email).expect(200);
      const stamp = await lastSeen(a, user.userId);
      expect(stamp).not.toBeNull();

      clock.set(new Date(clock.now().getTime() + 4 * MINUTE_MS));
      await postLogin(app, a.slug, user.email).expect(200);
      expect(await lastSeen(a, user.userId)).toEqual(stamp);

      clock.set(new Date(clock.now().getTime() + 2 * MINUTE_MS));
      await http(app).post(`${AUTH}/refresh`).send({ refreshToken: first.body.data.refreshToken }).expect(200);
      const refreshed = await lastSeen(a, user.userId);
      expect(refreshed!.getTime()).toBeGreaterThan(stamp!.getTime());

      clock.set(new Date(clock.now().getTime() + MINUTE_MS));
      const second = await postLogin(app, a.slug, user.email).expect(200);
      expect(await lastSeen(a, user.userId)).toEqual(refreshed);
      clock.set(new Date(clock.now().getTime() + 6 * MINUTE_MS));
      await http(app).post(`${AUTH}/refresh`).send({ refreshToken: second.body.data.refreshToken }).expect(200);
      expect((await lastSeen(a, user.userId))!.getTime()).toBeGreaterThan(refreshed!.getTime());
      clock.reset();
    });

    it('figure dans GET /iam/users et GET /iam/users/{id}', async () => {
      const user = await createUserWithRole(app, a, 'cashier');
      await postLogin(app, a.slug, user.email).expect(200);

      const detail = await http(app).get(`/api/v1/iam/users/${user.userId}`).set(bearer(a.adminToken)).expect(200);
      const list = await http(app).get('/api/v1/iam/users?limit=100').set(bearer(a.adminToken)).expect(200);

      expect(detail.body.data.lastSeenAt).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
      expect((list.body.data as { id: string; lastSeenAt: string | null }[]).find((u) => u.id === user.userId)!.lastSeenAt).not.toBeNull();
    });
  });
});
