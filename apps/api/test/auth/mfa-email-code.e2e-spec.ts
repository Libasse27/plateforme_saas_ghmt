import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { createTenantFixture, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { AUTH, bearer, distinctClientIp, http, lastEmailCode, loginOk, memoryMailer, totpCode } from './auth-helpers';

/** Plage publique (les plages privées, réservées et de documentation sont refusées comme réseaux de confiance). */
const TRUSTED_CIDR = '41.82.210.0/24';
const TRUSTED_IP = '41.82.210.9';

describe('auth : enrôlement TOTP hors réseau de confiance, code reçu par e-mail (docs/11 D7)', () => {
  let app: INestApplication;
  let tenant: TenantFixture;

  const sendCode = (token: string, ip: string = distinctClientIp()) => http(app).post(`${AUTH}/mfa/totp/email-code`).set('X-Forwarded-For', ip).set(bearer(token));
  const setup = (token: string, body?: Record<string, unknown>, ip: string = distinctClientIp()) => {
    const request = http(app).post(`${AUTH}/mfa/totp/setup`).set('X-Forwarded-For', ip).set(bearer(token));
    return body ? request.send(body) : request;
  };
  const newUser = async (): Promise<{ user: UserFixture; token: string }> => {
    const user = await createUserWithRole(app, tenant, 'cashier', { scopeType: 'tenant' }, false);
    return { user, token: (await loginOk(app, tenant, user.email)).accessToken };
  };

  beforeAll(async () => {
    app = await createTestApp();
    tenant = await createTenantFixture(app, { prefix: 'emailcode' });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('exige le code hors réseau : setup sans code ⇒ 403 mfa_email_code_required', async () => {
    const { token } = await newUser();

    const res = await setup(token).expect(403);

    expect(res.body.code).toBe('mfa_email_code_required');
  });

  it('envoie un code à 6 chiffres à l’adresse du compte (masquée dans la réponse), stocké haché', async () => {
    const { user, token } = await newUser();

    const res = await sendCode(token).expect(202);

    expect(res.body.data).toEqual({ sent: true, emailMasked: expect.stringContaining('***') });
    expect(res.body.data.emailMasked).not.toBe(user.email);
    const code = lastEmailCode(app, user.email);
    expect(code).toMatch(/^\d{6}$/);
    const rows = await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.mfaEmailCode.findMany({ where: { userId: user.userId } }));
    expect(rows).toHaveLength(1);
    expect(Buffer.from(rows[0]!.codeHash).toString('utf8')).not.toContain(code);
    expect(rows[0]!.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(10 * 60_000);
  });

  it('refuse un faux code (422 invalid_email_code), puis accepte le bon et délivre le secret ; activate reste inchangé', async () => {
    const { user, token } = await newUser();
    await sendCode(token).expect(202);
    const code = lastEmailCode(app, user.email);

    const wrong = await setup(token, { emailCode: code === '000000' ? '000001' : '000000' }).expect(422);
    const ok = await setup(token, { emailCode: code }).expect(200);
    const activated = await http(app)
      .post(`${AUTH}/mfa/totp/activate`)
      .set(bearer(token))
      .send({ code: await totpCode(ok.body.data.secret) })
      .expect(200);

    expect(wrong.body.code).toBe('invalid_email_code');
    expect(ok.body.data.otpauthUrl).toMatch(/^otpauth:\/\/totp\/GHMT:/);
    expect(activated.body.data.backupCodes).toHaveLength(10);
    const audits = await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.auditLog.findMany({ where: { action: { startsWith: 'auth.mfa.email_code' } } }));
    expect(audits.filter((a) => a.resourceId === user.userId).map((a) => a.action).sort()).toEqual(['auth.mfa.email_code_failed', 'auth.mfa.email_code_sent']);
  });

  it('consomme le code à la réussite du setup : il ne sert qu’une fois', async () => {
    const { user, token } = await newUser();
    await sendCode(token).expect(202);
    const code = lastEmailCode(app, user.email);
    await setup(token, { emailCode: code }).expect(200);

    const replay = await setup(token, { emailCode: code }).expect(422);

    expect(replay.body.code).toBe('invalid_email_code');
  });

  it('invalide le code au 5e essai faux, même avec le bon code ensuite', async () => {
    const { user, token } = await newUser();
    await sendCode(token).expect(202);
    const code = lastEmailCode(app, user.email);
    const wrong = code === '111111' ? '222222' : '111111';
    for (let i = 0; i < 5; i += 1) await setup(token, { emailCode: wrong }).expect(422);

    const res = await setup(token, { emailCode: code }).expect(422);

    expect(res.body.code).toBe('invalid_email_code');
  });

  it('refuse le code d’une autre session du même utilisateur', async () => {
    const { user, token } = await newUser();
    const secondSession = (await loginOk(app, tenant, user.email)).accessToken;
    await sendCode(token).expect(202);

    const res = await setup(secondSession, { emailCode: lastEmailCode(app, user.email) }).expect(422);

    expect(res.body.code).toBe('invalid_email_code');
  });

  it('un nouvel envoi invalide le code précédent', async () => {
    const { user, token } = await newUser();
    await sendCode(token).expect(202);
    const first = lastEmailCode(app, user.email);
    memoryMailer(app).clear();
    await sendCode(token).expect(202);
    const second = lastEmailCode(app, user.email);

    if (first !== second) await setup(token, { emailCode: first }).expect(422);
    await setup(token, { emailCode: second }).expect(200);
  });

  it('limite à 3 envois par utilisateur et par 15 minutes (429)', async () => {
    const { token } = await newUser();
    for (let i = 0; i < 3; i += 1) await sendCode(token).expect(202);

    const res = await sendCode(token).expect(429);

    expect(res.body.code).toBe('rate_limited');
  });

  it('compte les envois de façon atomique : six demandes simultanées ⇒ trois codes au plus (docs/11 §14.2)', async () => {
    const { user, token } = await newUser();

    const responses = await Promise.all(Array.from({ length: 6 }, () => sendCode(token)));

    expect(responses.filter((r) => r.status === 202)).toHaveLength(3);
    expect(responses.filter((r) => r.status === 429)).toHaveLength(3);
    const rows = await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.mfaEmailCode.count({ where: { userId: user.userId } }));
    expect(rows).toBe(3);
  });

  it('refuse un format de code invalide (422) et exige l’authentification (401)', async () => {
    const { token } = await newUser();

    await setup(token, { emailCode: '12345' }).expect(422);
    await http(app).post(`${AUTH}/mfa/totp/email-code`).expect(401);
  });

  it('répond 409 mfa_already_enrolled si un facteur est déjà activé', async () => {
    const { user, token } = await newUser();
    await sendCode(token).expect(202);
    const ok = await setup(token, { emailCode: lastEmailCode(app, user.email) }).expect(200);
    await http(app).post(`${AUTH}/mfa/totp/activate`).set(bearer(token)).send({ code: await totpCode(ok.body.data.secret) }).expect(200);

    expect((await sendCode(token).expect(409)).body.code).toBe('mfa_already_enrolled');
    expect((await setup(token).expect(409)).body.code).toBe('mfa_already_enrolled');
  });

  describe('sur un réseau de confiance', () => {
    beforeAll(async () => {
      // Écrite directement : la gestion des plages (principal seul, code TOTP) est couverte par les tests IAM.
      await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.trustedNetwork.create({ data: { tenantId: tenant.tenantId, network: TRUSTED_CIDR, label: 'Siège' } }));
    });

    it('n’exige aucun code : email-code ⇒ 422 email_code_not_required, setup sans code ⇒ 200', async () => {
      const { token } = await newUser();

      expect((await sendCode(token, TRUSTED_IP).expect(422)).body.code).toBe('email_code_not_required');
      await setup(token, undefined, TRUSTED_IP).expect(200);
    });
  });
});
