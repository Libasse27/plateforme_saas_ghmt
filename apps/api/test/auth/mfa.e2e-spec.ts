import type { INestApplication } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { createTenantFixture, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { AUTH, bearer, enrollTotp, http, loginOk, postLogin, postMfaVerify, totpCode } from './auth-helpers';

const STEP = 30;

describe('auth : second facteur TOTP et codes de secours', () => {
  let app: INestApplication;
  let tenantDb: TenantDb;
  let tenant: TenantFixture;
  let flowUser: UserFixture;
  let exhaustUser: UserFixture;
  let flowSecret: string;
  let flowBackupCodes: string[];

  const verify = (challengeId: string, code: string) => postMfaVerify(app, challengeId, code);
  /** Simule l'écoulement du temps : le dernier pas accepté est ramené loin dans le passé. */
  const rewindLastStep = (userId: string) =>
    tenantDb.runAs(tenant.tenantId, (tx) =>
      tx.mfaFactor.updateMany({ where: { userId }, data: { lastUsedStep: BigInt(Math.floor(Date.now() / 1000 / STEP) - 10) } }),
    );
  const challengeFor = async (email: string): Promise<string> => {
    const res = await postLogin(app, tenant.slug, email).expect(200);
    return res.body.data.challengeId as string;
  };

  beforeAll(async () => {
    app = await createTestApp();
    tenantDb = app.get(TenantDb);
    tenant = await createTenantFixture(app, { prefix: 'mfa' });
    [flowUser, exhaustUser] = await Promise.all([
      createUserWithRole(app, tenant, 'doctor', { scopeType: 'tenant' }, false),
      createUserWithRole(app, tenant, 'nurse', { scopeType: 'tenant' }, false),
    ]);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('setup renvoie un secret et une URL otpauth, stocke le secret chiffré, et refuse un code faux à l’activation', async () => {
    const login = await loginOk(app, tenant, flowUser.email);

    const setup = await http(app).post(`${AUTH}/mfa/totp/setup`).set(bearer(login.accessToken)).expect(200);
    const wrong = await http(app).post(`${AUTH}/mfa/totp/activate`).set(bearer(login.accessToken)).send({ code: '000000' }).expect(422);

    flowSecret = setup.body.data.secret;
    expect(setup.body.data.otpauthUrl).toMatch(/^otpauth:\/\/totp\/GHMT:/);
    expect(setup.body.data.otpauthUrl).toContain(flowSecret);
    const factor = await tenantDb.runAs(tenant.tenantId, (tx) => tx.mfaFactor.findFirstOrThrow({ where: { userId: flowUser.userId } }));
    expect(factor.activatedAt).toBeNull();
    expect(Buffer.from(factor.secretEnc).includes(Buffer.from(flowSecret))).toBe(false);
    expect(wrong.body.code).toBe('invalid_code');
  });

  it('activate renvoie 10 codes de secours hachés en base et un jeton mfa=true ; la session est vérifiée', async () => {
    const login = await loginOk(app, tenant, flowUser.email);
    const setup = await http(app).post(`${AUTH}/mfa/totp/setup`).set(bearer(login.accessToken)).expect(200);
    flowSecret = setup.body.data.secret;

    const res = await http(app)
      .post(`${AUTH}/mfa/totp/activate`)
      .set(bearer(login.accessToken))
      .send({ code: await totpCode(flowSecret) })
      .expect(200);
    flowBackupCodes = res.body.data.backupCodes;

    expect(flowBackupCodes).toHaveLength(10);
    for (const code of flowBackupCodes) expect(code).toMatch(/^[A-Z2-9]{10}$/);
    const factor = await tenantDb.runAs(tenant.tenantId, (tx) => tx.mfaFactor.findFirstOrThrow({ where: { userId: flowUser.userId } }));
    expect(factor.activatedAt).not.toBeNull();
    expect(factor.backupCodeHashes).toHaveLength(10);
    expect(factor.backupCodeHashes.some((h) => flowBackupCodes.includes(h))).toBe(false);
    const me = await http(app).get(`${AUTH}/me`).set(bearer(res.body.data.accessToken)).expect(200);
    expect(me.body.data.mfa).toEqual({ enrolled: true, verified: true, required: false });
    const session = await tenantDb.runAs(tenant.tenantId, (tx) => tx.session.findMany({ where: { userId: flowUser.userId, mfaVerifiedAt: { not: null } } }));
    expect(session).toHaveLength(1);
  });

  it('refuse un second setup quand le facteur est déjà activé (409)', async () => {
    const res = await http(app).post(`${AUTH}/mfa/totp/setup`).set(bearer(flowUser.token)).expect(409);

    expect(res.body.code).toBe('mfa_already_enrolled');
  });

  it('login avec facteur actif répond mfaRequired sans jeton, puis verify TOTP émet une session mfa=true', async () => {
    await rewindLastStep(flowUser.userId);
    const login = await postLogin(app, tenant.slug, flowUser.email).expect(200);

    const code = await totpCode(flowSecret, 2 * STEP);
    expect(login.body.data).toEqual({ mfaRequired: true, challengeId: expect.any(String), methods: ['totp', 'backup_code'] });
    expect(login.body.data.challengeId.split('.')[0]).toBe(tenant.tenantId);
    // pas de 2 pas d'écart : la fenêtre est ±1, ce code est rejeté
    await verify(login.body.data.challengeId, code).expect(401);
    const ok = await verify(login.body.data.challengeId, await totpCode(flowSecret, STEP)).expect(200);
    const me = await http(app).get(`${AUTH}/me`).set(bearer(ok.body.data.accessToken)).expect(200);

    expect(ok.body.data).toMatchObject({ mfaEnrolled: true, mfaRequired: false, expiresIn: 900 });
    expect(me.body.data.mfa.verified).toBe(true);
  });

  it('refuse le rejeu d’un code TOTP déjà consommé (anti-rejeu du pas)', async () => {
    await rewindLastStep(flowUser.userId);
    const first = await challengeFor(flowUser.email);
    const code = await totpCode(flowSecret, STEP);
    await verify(first, code).expect(200);
    const second = await challengeFor(flowUser.email);

    await verify(second, code).expect(401);
    await verify(second, await totpCode(flowSecret)).expect(401);
  });

  it('accepte un code de secours une seule fois', async () => {
    const backup = flowBackupCodes[0]!;
    const first = await challengeFor(flowUser.email);
    const res = await verify(first, backup).expect(200);
    const second = await challengeFor(flowUser.email);

    await verify(second, backup).expect(401);
    const factor = await tenantDb.runAs(tenant.tenantId, (tx) => tx.mfaFactor.findFirstOrThrow({ where: { userId: flowUser.userId } }));
    expect(factor.backupCodeHashes).toHaveLength(9);
    expect(res.body.data.mfaEnrolled).toBe(true);
  });

  it('refuse un challenge forgé, expiré, ou d’un autre tenant, et valide le format (422)', async () => {
    const forged = `${tenant.tenantId}.${randomBytes(32).toString('base64url')}`;
    const foreign = `${randomUUID()}.${randomBytes(32).toString('base64url')}`;
    const expired = await challengeFor(flowUser.email);
    await tenantDb.runAs(tenant.tenantId, (tx) =>
      tx.mfaChallenge.updateMany({ where: { userId: flowUser.userId }, data: { expiresAt: new Date(Date.now() - 1000) } }),
    );
    const code = await totpCode(flowSecret, STEP);

    await verify(forged, code).expect(401);
    await verify(foreign, code).expect(401);
    await verify(expired, code).expect(401);
    await verify('court', code).expect(422);
    await verify(forged, 'abc').expect(422);
  });

  it('bloque le challenge après 5 essais faux, même avec le bon code, et verrouille le compte', async () => {
    const { secret } = await enrollTotp(app, exhaustUser.token);
    const challenge = await challengeFor(exhaustUser.email);

    for (let i = 0; i < 5; i += 1) await verify(challenge, '000001').expect(401);
    await verify(challenge, await totpCode(secret, STEP)).expect(401);
    const relogin = await postLogin(app, tenant.slug, exhaustUser.email).expect(401);

    expect(relogin.body.code).toBe('invalid_credentials');
  });
});
