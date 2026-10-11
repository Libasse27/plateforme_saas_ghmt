import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { StepUpService } from '../../src/modules/iam/services/step-up.service';
import { bearer, http } from '../auth/auth-helpers';
import { createTenantFixture, type TenantFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { activateTotp, auditEntries, stepUpCode, wrongTotpCode } from '../iam/support';

const POLICY = '/api/v1/iam/security/policy';
const NETWORKS = '/api/v1/iam/security/trusted-networks';
const HOSPITAL_NETWORK = '41.82.10.0/24';

/** Code TOTP des opérations de pouvoir (docs/11 décision 23) : échecs audités, plafond par utilisateur, anti-rejeu durable. */
describe('iam : code TOTP des opérations de pouvoir', () => {
  let app: INestApplication;
  let tenant: TenantFixture;
  let locked: TenantFixture;
  let secret: string;
  let lockedSecret: string;

  const clearNetworks = () => app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.trustedNetwork.deleteMany({}));

  beforeAll(async () => {
    app = await createTestApp();
    [tenant, locked] = await Promise.all([createTenantFixture(app, { prefix: 'stepup' }), createTenantFixture(app, { prefix: 'stepup-b' })]);
    [secret, lockedSecret] = await Promise.all([activateTotp(app, tenant.tenantId, tenant.adminUserId), activateTotp(app, locked.tenantId, locked.adminUserId)]);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('audite un code faux (auth.stepup.failed, sans le code) malgré le refus 401', async () => {
    const wrong = await wrongTotpCode(secret);

    const res = await http(app).patch(POLICY).set(bearer(tenant.adminToken)).send({ clinicalMfa: 'always', totpCode: wrong }).expect(401);

    expect(res.body.code).toBe('mfa_code_invalid');
    const audits = await auditEntries(app, tenant.tenantId, 'auth.stepup.failed');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorUserId: tenant.adminUserId, outcome: 'failure' });
    expect(JSON.stringify(audits[0]!.changes)).not.toContain(wrong);
  });

  it('un doublon détecté avant le code (409) ne consomme pas le code', async () => {
    await http(app).post(NETWORKS).set(bearer(tenant.adminToken)).send({ cidr: HOSPITAL_NETWORK, label: 'Siège', totpCode: await stepUpCode(app, tenant.tenantId, tenant.adminUserId, secret) }).expect(201);
    const fresh = await stepUpCode(app, tenant.tenantId, tenant.adminUserId, secret);

    const duplicate = await http(app).post(NETWORKS).set(bearer(tenant.adminToken)).send({ cidr: HOSPITAL_NETWORK, label: 'Doublon', totpCode: fresh }).expect(409);
    await http(app).post(NETWORKS).set(bearer(tenant.adminToken)).send({ cidr: '196.1.2.0/24', label: 'Autre', totpCode: fresh }).expect(201);

    expect(duplicate.body.code).toBe('trusted_network_exists');
    await clearNetworks();
  });

  it('un code consommé par une opération qui échoue ensuite (doublon concurrent, 409) ne peut pas être rejoué', async () => {
    const stepUp = app.get(StepUpService);
    const confirm = stepUp.confirm.bind(stepUp);
    // Course : la même plage est déclarée entre la vérification du code et l'écriture.
    vi.spyOn(stepUp, 'confirm').mockImplementationOnce(async (...args) => {
      await confirm(...args);
      await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.trustedNetwork.create({ data: { tenantId: tenant.tenantId, network: HOSPITAL_NETWORK, label: 'Concurrent' } }));
    });
    const used = await stepUpCode(app, tenant.tenantId, tenant.adminUserId, secret);

    const duplicate = await http(app).post(NETWORKS).set(bearer(tenant.adminToken)).send({ cidr: HOSPITAL_NETWORK, label: 'Siège', totpCode: used }).expect(409);
    const replay = await http(app).post(NETWORKS).set(bearer(tenant.adminToken)).send({ cidr: '196.1.2.0/24', label: 'Autre', totpCode: used }).expect(401);

    expect(duplicate.body.code).toBe('trusted_network_exists');
    expect(replay.body.code).toBe('mfa_code_invalid');
    await clearNetworks();
  });

  it('un code consommé par une suppression introuvable (404) ne peut pas être rejoué', async () => {
    const used = await stepUpCode(app, tenant.tenantId, tenant.adminUserId, secret);

    await http(app).delete(`${NETWORKS}/00000000-0000-4000-8000-000000000000`).set(bearer(tenant.adminToken)).send({ totpCode: used }).expect(404);
    const replay = await http(app).patch(POLICY).set(bearer(tenant.adminToken)).send({ clinicalMfa: 'off_network', totpCode: used }).expect(401);

    expect(replay.body.code).toBe('mfa_code_invalid');
  });

  it('après 5 codes faux en 15 minutes, refuse même un bon code (429) et trace le blocage', async () => {
    const wrong = await wrongTotpCode(lockedSecret);
    for (let i = 0; i < 5; i += 1) {
      await http(app).patch(POLICY).set(bearer(locked.adminToken)).send({ clinicalMfa: 'always', totpCode: wrong }).expect(401);
    }

    const blocked = await http(app)
      .patch(POLICY)
      .set(bearer(locked.adminToken))
      .send({ clinicalMfa: 'always', totpCode: await stepUpCode(app, locked.tenantId, locked.adminUserId, lockedSecret) })
      .expect(429);

    expect(blocked.headers['retry-after']).toBeDefined();
    expect(await auditEntries(app, locked.tenantId, 'auth.stepup.failed')).toHaveLength(5);
    expect(await auditEntries(app, locked.tenantId, 'auth.stepup.locked')).toHaveLength(1);
    const policy = await http(app).get(POLICY).set(bearer(locked.adminToken)).expect(200);
    expect(policy.body.data.clinicalMfa).toBe('off_network');
  });

  it('un bon code ne compte pas comme un échec', async () => {
    for (let i = 0; i < 6; i += 1) {
      await http(app).patch(POLICY).set(bearer(tenant.adminToken)).send({ clinicalMfa: 'off_network', totpCode: await stepUpCode(app, tenant.tenantId, tenant.adminUserId, secret) }).expect(200);
    }
  });
});
