import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BackgroundTasks } from '../../src/common/tasks/background-tasks';
import { PlatformDb } from '../../src/infrastructure/prisma/platform-db.service';
import { createPatientRow } from '../appointments/appointment-fixtures';
import { createTenantFixture, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { AUTH, bearer, distinctClientIp, enrollTotp, http, loginOk, memoryMailer, postLogin, postMfaVerify, totpCode } from './auth-helpers';

const STEP = 30;

/**
 * Établissement `suspended` (impayé) : la continuité des soins exige que les soignants et les administrateurs puissent se
 * connecter, rafraîchir leur session et réinitialiser leur mot de passe (docs/11 §14.1, C1). Le guard applique ensuite le
 * mode lecture seule sur les écritures non essentielles.
 */
describe('auth : connexion à un établissement suspendu (docs/11 §14.2 C1)', () => {
  let app: INestApplication;
  let tenant: TenantFixture;
  let doctor: UserFixture;
  let doctorSecret: string;
  let doctorBackupCodes: string[];
  let adminSecret: string;
  let patientId: string;

  /** Connexion réelle avec second facteur : mot de passe, challenge, puis code (TOTP du pas suivant, anti-rejeu, ou code de secours). */
  const loginWithCode = async (email: string, code: string) => {
    const challenge = await postLogin(app, tenant.slug, email).expect(200);
    expect(challenge.body.data.mfaRequired).toBe(true);
    const verified = await postMfaVerify(app, challenge.body.data.challengeId, code).expect(200);
    return verified.body.data as { accessToken: string; refreshToken: string };
  };
  const loginWithTotp = async (email: string, secret: string) => loginWithCode(email, await totpCode(secret, STEP));

  beforeAll(async () => {
    app = await createTestApp();
    tenant = await createTenantFixture(app, { prefix: 'susp' });
    doctor = await createUserWithRole(app, tenant, 'doctor');
    patientId = await createPatientRow(app, tenant);
    ({ secret: doctorSecret, backupCodes: doctorBackupCodes } = await enrollTotp(app, (await loginOk(app, tenant, doctor.email)).accessToken, doctor.email));
    adminSecret = (await enrollTotp(app, (await loginOk(app, tenant, tenant.adminEmail)).accessToken, tenant.adminEmail)).secret;
    await app.get(PlatformDb).run((tx) => tx.tenant.update({ where: { id: tenant.tenantId }, data: { status: 'suspended' } }));
  });

  afterAll(async () => {
    await app?.close();
  });

  it('un médecin se connecte (mot de passe + TOTP) puis lit un dossier patient', async () => {
    const session = await loginWithTotp(doctor.email, doctorSecret);

    const patient = await http(app).get(`/api/v1/patients/${patientId}`).set(bearer(session.accessToken)).expect(200);

    expect(patient.body.data.id).toBe(patientId);
  });

  it('un administrateur se connecte puis consulte la liste des utilisateurs', async () => {
    const session = await loginWithTotp(tenant.adminEmail, adminSecret);

    await http(app).get('/api/v1/iam/users').set(bearer(session.accessToken)).expect(200);
  });

  it('le refresh reste possible', async () => {
    const session = await loginWithCode(doctor.email, doctorBackupCodes[0]!);

    const refreshed = await http(app).post(`${AUTH}/refresh`).set('X-Forwarded-For', distinctClientIp()).send({ refreshToken: session.refreshToken }).expect(200);

    await http(app).get(`/api/v1/patients/${patientId}`).set(bearer(refreshed.body.data.accessToken)).expect(200);
  });

  it('le mot de passe oublié envoie un lien de réinitialisation utilisable', async () => {
    memoryMailer(app).clear();
    await http(app).post(`${AUTH}/password/forgot`).set('X-Forwarded-For', distinctClientIp()).send({ tenantSlug: tenant.slug, email: doctor.email }).expect(202);
    await app.get(BackgroundTasks).drain();
    const token = /\/reinitialiser\/([A-Za-z0-9._-]+)/.exec(memoryMailer(app).lastTo(doctor.email)?.text ?? '')?.[1];

    expect(token).toBeDefined();
    const preview = await http(app).post(`${AUTH}/password/reset/preview`).set('X-Forwarded-For', distinctClientIp()).send({ token }).expect(200);
    expect(preview.body.data.mfaRequired).toBe(true);
  });

  it('un établissement résilié (terminated) reste refusé à la connexion et au refresh', async () => {
    const closed = await createTenantFixture(app, { prefix: 'term' });
    const session = await loginOk(app, closed, (await createUserWithRole(app, closed, 'cashier')).email);
    await app.get(PlatformDb).run((tx) => tx.tenant.update({ where: { id: closed.tenantId }, data: { status: 'terminated' } }));

    expect((await postLogin(app, closed.slug, closed.adminEmail).expect(401)).body.code).toBe('invalid_credentials');
    await http(app).post(`${AUTH}/refresh`).set('X-Forwarded-For', distinctClientIp()).send({ refreshToken: session.refreshToken }).expect(401);
  });
});
