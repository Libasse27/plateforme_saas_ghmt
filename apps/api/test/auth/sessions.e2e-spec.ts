import type { INestApplication } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { createTenantFixture, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { AUTH, TEST_USER_AGENT, bearer, http, loginOk, type LoginBody } from './auth-helpers';

const SECOND_MS = 1000;

describe('auth : refresh, déconnexion, sessions, isolation', () => {
  let app: INestApplication;
  let tenantDb: TenantDb;
  let a: TenantFixture;
  let b: TenantFixture;
  let userA: UserFixture;
  let colleagueA: UserFixture;
  let userB: UserFixture;

  const refresh = (refreshToken: string) => http(app).post(`${AUTH}/refresh`).send({ refreshToken });
  const me = (accessToken: string) => http(app).get(`${AUTH}/me`).set(bearer(accessToken));
  const login = (tenant: TenantFixture, user: UserFixture): Promise<LoginBody> => loginOk(app, tenant, user.email);

  /** Antidate la consommation d'un refresh token (simule le temps écoulé sans attendre). */
  const ageUsedAt = async (tenantId: string, rawToken: string, secondsAgo: number): Promise<void> => {
    const { parseOpaqueToken } = await import('../../src/common/auth/opaque-token');
    const parsed = parseOpaqueToken(rawToken)!;
    await tenantDb.runAs(tenantId, (tx) =>
      tx.refreshToken.update({
        where: { tenantId_tokenHash: { tenantId, tokenHash: parsed.hash } },
        data: { usedAt: new Date(Date.now() - secondsAgo * SECOND_MS) },
      }),
    );
  };

  beforeAll(async () => {
    app = await createTestApp();
    tenantDb = app.get(TenantDb);
    [a, b] = await Promise.all([createTenantFixture(app, { prefix: 'sess-a' }), createTenantFixture(app, { prefix: 'sess-b' })]);
    [userA, colleagueA, userB] = await Promise.all([
      createUserWithRole(app, a, 'receptionist'),
      createUserWithRole(app, a, 'doctor'),
      createUserWithRole(app, b, 'receptionist'),
    ]);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('fait tourner le refresh token : nouvelle paire, l’ancien jeton d’accès reste valide jusqu’à expiration', async () => {
    const first = await login(a, userA);

    const res = await refresh(first.refreshToken).expect(200);

    expect(res.body.data).toEqual({ accessToken: expect.any(String), refreshToken: expect.any(String), expiresIn: 900 });
    expect(res.body.data.refreshToken).not.toBe(first.refreshToken);
    await me(res.body.data.accessToken).expect(200);
    const rows = await tenantDb.runAs(a.tenantId, (tx) => tx.refreshToken.findMany({ where: { session: { userId: userA.userId } } }));
    const consumed = rows.filter((r) => r.usedAt !== null);
    expect(consumed.length).toBeGreaterThanOrEqual(1);
    expect(consumed[0]!.replacedById).toBeTruthy();
    expect(new Set(rows.map((r) => r.familyId)).size).toBeGreaterThanOrEqual(1);
  });

  it('tolère le rejeu réseau d’un jeton consommé depuis moins de 10 s sans révoquer la session', async () => {
    const first = await login(a, userA);
    await refresh(first.refreshToken).expect(200);

    const replay = await refresh(first.refreshToken).expect(200);

    expect(replay.body.data.refreshToken).not.toBe(first.refreshToken);
    await me(first.accessToken).expect(200);
    await me(replay.body.data.accessToken).expect(200);
  });

  it('détecte la réutilisation au-delà de 10 s : révoque la famille et la session, audite, 401', async () => {
    const first = await login(a, userA);
    const rotated = await refresh(first.refreshToken).expect(200);
    await ageUsedAt(a.tenantId, first.refreshToken, 20);

    const reuse = await refresh(first.refreshToken).expect(401);
    const afterReuse = await refresh(rotated.body.data.refreshToken).expect(401);

    expect(reuse.body.code).toBe('unauthenticated');
    expect(afterReuse.body.code).toBe('unauthenticated');
    await me(first.accessToken).expect(401);
    await me(rotated.body.data.accessToken).expect(401);
    const audit = await tenantDb.runAs(a.tenantId, (tx) =>
      tx.auditLog.findMany({ where: { action: 'auth.refresh.reuse_detected', actorUserId: userA.userId } }),
    );
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  it('gère deux refresh simultanés du même jeton sans double consommation ni révocation', async () => {
    const first = await login(a, userA);

    const [x, y] = await Promise.all([refresh(first.refreshToken), refresh(first.refreshToken)]);

    expect([x.status, y.status]).toEqual([200, 200]);
    expect(x.body.data.refreshToken).not.toBe(y.body.data.refreshToken);
    await me(x.body.data.accessToken).expect(200);
    const { parseOpaqueToken } = await import('../../src/common/auth/opaque-token');
    const family = await tenantDb.runAs(a.tenantId, async (tx) => {
      const original = await tx.refreshToken.findUniqueOrThrow({
        where: { tenantId_tokenHash: { tenantId: a.tenantId, tokenHash: parseOpaqueToken(first.refreshToken)!.hash } },
      });
      const [consumed, live] = await Promise.all([
        tx.refreshToken.count({ where: { familyId: original.familyId, usedAt: { not: null } } }),
        tx.refreshToken.count({ where: { familyId: original.familyId, usedAt: null } }),
      ]);
      return { consumed, live };
    });
    // Le jeton d'origine est consommé une seule fois ; le remplaçant du perdant de la course (jeton de grâce)
    // est révoqué (L1) : il ne reste qu'un seul jeton utilisable dans la famille.
    expect(family).toEqual({ consumed: 2, live: 1 });
  });

  it('révoque le remplaçant inutilisé quand un jeton de grâce est émis (L1)', async () => {
    const first = await login(a, userA);
    const winner = await refresh(first.refreshToken).expect(200);

    const grace = await refresh(first.refreshToken).expect(200);

    expect(grace.body.data.refreshToken).not.toBe(winner.body.data.refreshToken);
    const { parseOpaqueToken } = await import('../../src/common/auth/opaque-token');
    const replacement = await tenantDb.runAs(a.tenantId, (tx) =>
      tx.refreshToken.findUniqueOrThrow({
        where: { tenantId_tokenHash: { tenantId: a.tenantId, tokenHash: parseOpaqueToken(winner.body.data.refreshToken)!.hash } },
      }),
    );
    expect(replacement.usedAt).not.toBeNull();
    // Le jeton révoqué ne sert plus qu'à rejouer dans la fenêtre de grâce ; passé 10 s, c'est une réutilisation (vol présumé).
    await ageUsedAt(a.tenantId, winner.body.data.refreshToken, 20);
    await refresh(winner.body.data.refreshToken).expect(401);
  });

  it('détecte la réutilisation si le remplaçant a déjà servi, même dans la fenêtre de grâce', async () => {
    const first = await login(a, userA);
    const second = await refresh(first.refreshToken).expect(200);
    await refresh(second.body.data.refreshToken).expect(200);

    await refresh(first.refreshToken).expect(401);

    await me(first.accessToken).expect(401);
  });

  it('refuse les jetons mal formés, inconnus, d’un autre tenant, expirés ; valide le corps (422)', async () => {
    const valid = await login(a, userA);
    const unknown = `${a.tenantId}.${randomBytes(32).toString('base64url')}`;
    const foreignSecret = valid.refreshToken.split('.')[1];
    const crossTenant = `${b.tenantId}.${foreignSecret}`;
    await tenantDb.runAs(a.tenantId, (tx) =>
      tx.refreshToken.updateMany({ where: { session: { userId: userA.userId }, usedAt: null }, data: { expiresAt: new Date(Date.now() - SECOND_MS) } }),
    );

    await refresh('x'.repeat(40)).expect(401);
    await refresh(unknown).expect(401);
    await refresh(crossTenant).expect(401);
    await refresh(valid.refreshToken).expect(401);
    await http(app).post(`${AUTH}/refresh`).send({}).expect(422);
  });

  it('logout révoque la session : le jeton d’accès et le refresh token sont refusés', async () => {
    const session = await login(a, userA);
    await me(session.accessToken).expect(200);

    await http(app).post(`${AUTH}/logout`).set(bearer(session.accessToken)).expect(204);

    await me(session.accessToken).expect(401);
    await refresh(session.refreshToken).expect(401);
    await http(app).post(`${AUTH}/logout`).expect(401);
  });

  it('logout public : le refresh token seul révoque la session, même sans jeton d’accès (C8)', async () => {
    const session = await login(a, userA);
    await me(session.accessToken).expect(200);

    await http(app).post(`${AUTH}/logout`).send({ refreshToken: session.refreshToken }).expect(204);

    await me(session.accessToken).expect(401);
    await refresh(session.refreshToken).expect(401);
    const audit = await tenantDb.runAs(a.tenantId, (tx) => tx.auditLog.findFirst({ where: { action: 'auth.logout', actorUserId: userA.userId }, orderBy: { chainSeq: 'desc' } }));
    expect(audit).not.toBeNull();
  });

  it('logout public : un refresh token déjà consommé révoque aussi la session', async () => {
    const first = await login(a, userA);
    const rotated = await refresh(first.refreshToken).expect(200);

    await http(app).post(`${AUTH}/logout`).send({ refreshToken: first.refreshToken }).expect(204);

    await refresh(rotated.body.data.refreshToken).expect(401);
    await me(rotated.body.data.accessToken).expect(401);
  });

  it('logout public : 204 identique pour un jeton inconnu, mal formé ou d’un autre tenant, sans effet sur les sessions', async () => {
    const keep = await login(a, userA);
    const unknown = `${a.tenantId}.${randomBytes(32).toString('base64url')}`;
    const crossTenant = `${b.tenantId}.${keep.refreshToken.split('.')[1]}`;

    for (const refreshToken of ['x'.repeat(40), unknown, crossTenant]) {
      await http(app).post(`${AUTH}/logout`).send({ refreshToken }).expect(204);
    }

    await me(keep.accessToken).expect(200);
    await refresh(keep.refreshToken).expect(200);
  });

  it('logout : refuse un jeton d’accès invalide ou l’absence de tout jeton (401) mais reste idempotent avec un jeton valide', async () => {
    const session = await login(a, userA);

    await http(app).post(`${AUTH}/logout`).set(bearer('jeton.invalide.xyz')).expect(401);
    await http(app).post(`${AUTH}/logout`).send({}).expect(401);
    await http(app).post(`${AUTH}/logout`).set(bearer(session.accessToken)).expect(204);
    await http(app).post(`${AUTH}/logout`).set(bearer(session.accessToken)).expect(204);
  });

  it('n’authentifie jamais par cookie (L4) : un cookie d’accès valide ne donne aucun accès', async () => {
    const session = await login(a, userA);

    await http(app).get(`${AUTH}/me`).set('Cookie', `__Host-ghmt_at=${session.accessToken}; ghmt_at=${session.accessToken}`).expect(401);
    await me(session.accessToken).expect(200);
  });

  it('liste uniquement les sessions actives de l’utilisateur et marque la session courante', async () => {
    const mine = await login(a, userA);
    const other = await login(a, colleagueA);

    const res = await http(app).get(`${AUTH}/sessions`).set(bearer(mine.accessToken)).expect(200);

    const sessions = res.body.data as { id: string; current: boolean }[];
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
    expect(sessions[0]).toEqual({
      id: expect.any(String),
      current: expect.any(Boolean),
      userAgent: TEST_USER_AGENT,
      ip: expect.stringMatching(/^[0-9a-f.:]+$/),
      mfaVerified: expect.any(Boolean),
      createdAt: expect.any(String),
      lastSeenAt: expect.any(String),
      expiresAt: expect.any(String),
    });
    const colleagueSessions = await tenantDb.runAs(a.tenantId, (tx) => tx.session.findMany({ where: { userId: colleagueA.userId }, select: { id: true } }));
    expect(sessions.some((s) => colleagueSessions.some((c) => c.id === s.id))).toBe(false);
    await me(other.accessToken).expect(200);
  });

  it('révoque une de ses sessions (204) ; un identifiant inconnu ou mal formé ⇒ 404', async () => {
    const keep = await login(a, userA);
    const drop = await login(a, userA);
    const list = await http(app).get(`${AUTH}/sessions`).set(bearer(keep.accessToken)).expect(200);
    const dropId = (list.body.data as { id: string; current: boolean }[]).find((s) => !s.current && s.id)!.id;
    const stale = await login(a, userA);

    await http(app).delete(`${AUTH}/sessions/${randomUUID()}`).set(bearer(keep.accessToken)).expect(404);
    await http(app).delete(`${AUTH}/sessions/pas-un-uuid`).set(bearer(keep.accessToken)).expect(404);
    await http(app).delete(`${AUTH}/sessions/${dropId}`).set(bearer(keep.accessToken)).expect(204);
    await http(app).delete(`${AUTH}/sessions/${dropId}`).set(bearer(keep.accessToken)).expect(404);

    await me(keep.accessToken).expect(200);
    expect([drop.accessToken, stale.accessToken]).toHaveLength(2);
  });

  it('isole les tenants : la session d’un autre tenant ou d’un collègue ⇒ 404 et reste active', async () => {
    const sessionB = await login(b, userB);
    const sessionColleague = await login(a, colleagueA);
    const mine = await login(a, userA);
    const idOf = async (tenantId: string, userId: string) =>
      (await tenantDb.runAs(tenantId, (tx) => tx.session.findFirstOrThrow({ where: { userId, revokedAt: null }, orderBy: { createdAt: 'desc' } }))).id;

    await http(app).delete(`${AUTH}/sessions/${await idOf(b.tenantId, userB.userId)}`).set(bearer(mine.accessToken)).expect(404);
    await http(app).delete(`${AUTH}/sessions/${await idOf(a.tenantId, colleagueA.userId)}`).set(bearer(mine.accessToken)).expect(404);

    await me(sessionB.accessToken).expect(200);
    await me(sessionColleague.accessToken).expect(200);
  });

  it('refuse /auth/me et /auth/sessions sans jeton (401)', async () => {
    await http(app).get(`${AUTH}/me`).expect(401);
    await http(app).get(`${AUTH}/sessions`).expect(401);
  });
});
