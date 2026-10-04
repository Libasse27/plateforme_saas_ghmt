import type { INestApplication } from '@nestjs/common';
import * as argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordService } from '../../src/common/auth/password.service';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { FIXTURE_PASSWORD, createTenantFixture, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { AUTH, bearer, http, loginOk, postLogin } from './auth-helpers';

const MINUTE_MS = 60_000;

describe('auth : connexion, anti-énumération, verrouillage', () => {
  let app: INestApplication;
  let tenantDb: TenantDb;
  let tenant: TenantFixture;
  let lockedUser: UserFixture;
  let rehashUser: UserFixture;
  let disabledUser: UserFixture;
  let auditUser: UserFixture;

  const credentialOf = (userId: string) =>
    tenantDb.runAs(tenant.tenantId, (tx) =>
      tx.userCredential.findUniqueOrThrow({ where: { tenantId_userId: { tenantId: tenant.tenantId, userId } } }),
    );

  beforeAll(async () => {
    app = await createTestApp();
    tenantDb = app.get(TenantDb);
    tenant = await createTenantFixture(app, { prefix: 'login' });
    [lockedUser, rehashUser, disabledUser, auditUser] = await Promise.all([
      createUserWithRole(app, tenant, 'receptionist'),
      createUserWithRole(app, tenant, 'doctor'),
      createUserWithRole(app, tenant, 'nurse'),
      createUserWithRole(app, tenant, 'cashier'),
    ]);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('émet des jetons et indique que la MFA est exigée par le rôle sans second facteur', async () => {
    const res = await postLogin(app, tenant.slug, tenant.adminEmail).expect(200);

    expect(res.body.data).toEqual({
      accessToken: expect.any(String),
      refreshToken: expect.stringMatching(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/),
      expiresIn: 900,
      mfaEnrolled: false,
      mfaRequired: true,
    });
  });

  it('indique mfaRequired=false pour un rôle sans exigence MFA, et le jeton porte mfa=false', async () => {
    const data = await loginOk(app, tenant, lockedUser.email);

    const me = await http(app).get(`${AUTH}/me`).set(bearer(data.accessToken)).expect(200);

    expect(data.mfaRequired).toBe(false);
    expect(me.body.data.mfa).toEqual({ enrolled: false, verified: false, required: false });
  });

  it('renvoie la même 401 générique pour mauvais mot de passe, utilisateur inconnu et tenant inconnu', async () => {
    const wrongPassword = await postLogin(app, tenant.slug, disabledUser.email, 'mauvais-mot-de-passe').expect(401);
    const unknownUser = await postLogin(app, tenant.slug, 'inconnu@nowhere.test').expect(401);
    const unknownTenant = await postLogin(app, 'etablissement-inexistant', tenant.adminEmail).expect(401);

    const shape = (body: Record<string, unknown>) => ({ status: body['status'], code: body['code'], detail: body['detail'] });
    expect(shape(wrongPassword.body)).toEqual({ status: 401, code: 'invalid_credentials', detail: 'Identifiants invalides.' });
    expect(shape(unknownUser.body)).toEqual(shape(wrongPassword.body));
    expect(shape(unknownTenant.body)).toEqual(shape(wrongPassword.body));
  });

  it('refuse un utilisateur désactivé avec la même 401 générique', async () => {
    await tenantDb.runAs(tenant.tenantId, (tx) =>
      tx.user.update({ where: { tenantId_id: { tenantId: tenant.tenantId, id: disabledUser.userId } }, data: { status: 'disabled' } }),
    );

    const res = await postLogin(app, tenant.slug, disabledUser.email).expect(401);

    expect(res.body.code).toBe('invalid_credentials');
  });

  it('verrouille le compte après 5 échecs, même avec le bon mot de passe, puis le libère à l’échéance', async () => {
    for (let i = 0; i < 5; i += 1) await postLogin(app, tenant.slug, lockedUser.email, 'mauvais-mot-de-passe').expect(401);
    const lockedAttempt = await postLogin(app, tenant.slug, lockedUser.email).expect(401);
    const locked = await credentialOf(lockedUser.userId);

    expect(lockedAttempt.body.code).toBe('invalid_credentials');
    expect(locked.failedAttempts).toBe(5);
    expect(locked.lockedUntil!.getTime() - Date.now()).toBeGreaterThan(MINUTE_MS - 5_000);
    expect(locked.lockedUntil!.getTime() - Date.now()).toBeLessThanOrEqual(MINUTE_MS);

    await tenantDb.runAs(tenant.tenantId, (tx) =>
      tx.userCredential.update({
        where: { tenantId_userId: { tenantId: tenant.tenantId, userId: lockedUser.userId } },
        data: { lockedUntil: new Date(Date.now() - 1000) },
      }),
    );
    await postLogin(app, tenant.slug, lockedUser.email).expect(200);
    const released = await credentialOf(lockedUser.userId);
    expect(released).toMatchObject({ failedAttempts: 0, lockedUntil: null });
  });

  it('compte atomiquement les échecs de tentatives parallèles et verrouille le compte', async () => {
    const racer = await createUserWithRole(app, tenant, 'stock_manager');

    const results = await Promise.all(Array.from({ length: 8 }, () => postLogin(app, tenant.slug, racer.email, 'mauvais-mot-de-passe')));

    const credential = await credentialOf(racer.userId);
    expect(results.every((r) => r.status === 401)).toBe(true);
    expect(credential.failedAttempts).toBe(8);
    expect(credential.lockedUntil).not.toBeNull();
  });

  it('rehache le mot de passe lorsque les paramètres Argon2 ont évolué', async () => {
    const weak = await argon2.hash(FIXTURE_PASSWORD, { type: argon2.argon2id, memoryCost: 8_192, timeCost: 2, parallelism: 1 });
    await tenantDb.runAs(tenant.tenantId, (tx) =>
      tx.userCredential.update({
        where: { tenantId_userId: { tenantId: tenant.tenantId, userId: rehashUser.userId } },
        data: { passwordHash: weak },
      }),
    );
    expect(app.get(PasswordService).needsRehash(weak)).toBe(true);

    await postLogin(app, tenant.slug, rehashUser.email).expect(200);

    const { passwordHash } = await credentialOf(rehashUser.userId);
    expect(passwordHash).not.toBe(weak);
    expect(app.get(PasswordService).needsRehash(passwordHash)).toBe(false);
    expect(await argon2.verify(passwordHash, FIXTURE_PASSWORD)).toBe(true);
  });

  it('audite succès et échecs sans jamais écrire l’email en clair', async () => {
    await postLogin(app, tenant.slug, auditUser.email, 'mauvais-mot-de-passe').expect(401);
    await postLogin(app, tenant.slug, 'fantome@nowhere.test').expect(401);
    await postLogin(app, tenant.slug, auditUser.email).expect(200);

    const rows = await tenantDb.runAs(tenant.tenantId, (tx) =>
      tx.auditLog.findMany({ where: { action: { startsWith: 'auth.login' } }, orderBy: { chainSeq: 'asc' } }),
    );

    const failedForUser = rows.filter((r) => r.action === 'auth.login.failed' && r.actorUserId === auditUser.userId);
    const failedAnonymous = rows.filter((r) => r.action === 'auth.login.failed' && r.actorType === 'anonymous');
    const successes = rows.filter((r) => r.action === 'auth.login.success' && r.actorUserId === auditUser.userId);
    expect(failedForUser).toHaveLength(1);
    expect(failedForUser[0]!.outcome).toBe('failure');
    expect(failedAnonymous.length).toBeGreaterThanOrEqual(1);
    expect(successes).toHaveLength(1);
    const serialized = JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    expect(serialized).not.toContain('@');
  });

  it.each([
    ['mot de passe absent', { tenantSlug: 'abc', email: 'a@b.test' }],
    ['email invalide', { tenantSlug: 'abc', email: 'pas-un-email', password: 'x' }],
    ['slug invalide', { tenantSlug: 'A B', email: 'a@b.test', password: 'x' }],
    ['corps vide', {}],
  ])('rejette un corps invalide (%s) en 422', async (_label, body) => {
    const res = await http(app).post(`${AUTH}/login`).send(body).expect(422);

    expect(res.body.code).toBe('validation_failed');
  });
});
