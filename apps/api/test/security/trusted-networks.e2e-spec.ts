import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { AUTH, bearer, http } from '../auth/auth-helpers';
import { createTenantFixture, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { activateTotp, stepUpCode, wrongTotpCode } from '../iam/support';
import { createPatientWithContacts } from '../notifications/notification-fixtures';

const POLICY = '/api/v1/iam/security/policy';
const NETWORKS = '/api/v1/iam/security/trusted-networks';
const ROUTE = '/api/v1/org/sites';
// Adresses publiques : les plages privées, spéciales et de documentation sont refusées (décision 23).
const HOSPITAL = '41.82.10.9';
const HOSPITAL_NETWORK = '41.82.10.0/24';
const ELSEWHERE = '154.124.5.20';

describe('iam : réseaux de confiance et MFA des soignants hors réseau (docs/11 D4-D6, §14.1)', () => {
  let app: INestApplication;
  let tenant: TenantFixture;
  let other: TenantFixture;
  let doctor: UserFixture;
  let cashier: UserFixture;
  let director: UserFixture;
  let admin2: UserFixture;
  let ownerSecret: string;
  let otherSecret: string;

  const code = () => stepUpCode(app, tenant.tenantId, tenant.adminUserId, ownerSecret);
  const from = (ip: string, token: string) => http(app).get(ROUTE).set('X-Forwarded-For', ip).set(bearer(token));
  // Le code est calculé avant la requête : une requête supertest est « thenable », on ne la renvoie pas depuis une fonction async.
  const addNetwork = async (cidr: string, status: number, extra: Record<string, unknown> = {}) =>
    http(app).post(NETWORKS).set(bearer(tenant.adminToken)).send({ cidr, label: 'Siège', totpCode: await code(), ...extra }).expect(status);
  const removeNetwork = async (id: string, status: number) =>
    http(app).delete(`${NETWORKS}/${id}`).set(bearer(tenant.adminToken)).send({ totpCode: await code() }).expect(status);
  const setMode = async (clinicalMfa: string, status = 200) =>
    http(app).patch(POLICY).set(bearer(tenant.adminToken)).send({ clinicalMfa, totpCode: await code() }).expect(status);
  const clearNetworks = async () => {
    await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.trustedNetwork.deleteMany({}));
  };
  const notificationsOf = (typeCode: string) =>
    app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.notification.findMany({ where: { typeCode }, select: { recipientId: true, channel: true } }));

  beforeAll(async () => {
    app = await createTestApp();
    [tenant, other] = await Promise.all([createTenantFixture(app, { prefix: 'net' }), createTenantFixture(app, { prefix: 'net-b' })]);
    [doctor, cashier, director, admin2] = await Promise.all([
      createUserWithRole(app, tenant, 'doctor', { scopeType: 'tenant' }, false),
      createUserWithRole(app, tenant, 'cashier', { scopeType: 'tenant' }, false),
      createUserWithRole(app, tenant, 'director'),
      createUserWithRole(app, tenant, 'tenant_admin'),
    ]);
    [ownerSecret, otherSecret] = await Promise.all([activateTotp(app, tenant.tenantId, tenant.adminUserId), activateTotp(app, other.tenantId, other.adminUserId)]);
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('GET/PATCH /iam/security/policy', () => {
    it('expose la politique par défaut, l’IP de la requête, le principal, canManage et le nombre de soignants sans second facteur', async () => {
      const res = await http(app).get(POLICY).set('X-Forwarded-For', HOSPITAL).set(bearer(tenant.adminToken)).expect(200);

      expect(res.body.data).toMatchObject({
        clinicalMfa: 'off_network',
        trustedNetworks: [],
        requestIp: HOSPITAL,
        requestIpTrusted: false,
        owner: { id: tenant.adminUserId, fullName: 'Admin Test' },
        canManage: true,
        clinicalUsersWithoutMfa: 1,
      });
    });

    it('canManage est faux pour un administrateur non principal', async () => {
      const res = await http(app).get(POLICY).set(bearer(admin2.token)).expect(200);

      expect(res.body.data.canManage).toBe(false);
    });

    it('traite une IP privée ou spéciale comme absente', async () => {
      const res = await http(app).get(POLICY).set('X-Forwarded-For', '10.1.2.3').set(bearer(tenant.adminToken)).expect(200);

      expect(res.body.data).toMatchObject({ requestIp: null, requestIpTrusted: false });
    });

    it('refuse un utilisateur sans iam:policy (403) en lecture et en écriture', async () => {
      await http(app).get(POLICY).set(bearer(director.token)).expect(403);
      await http(app).patch(POLICY).set(bearer(director.token)).send({ clinicalMfa: 'always' }).expect(403);
      await http(app).post(NETWORKS).set(bearer(director.token)).send({ cidr: HOSPITAL_NETWORK, label: 'Siège' }).expect(403);
      await http(app).get(POLICY).expect(401);
    });

    it('refuse un mode inconnu (422) et audite la mise à jour', async () => {
      expect((await setMode('disabled', 422)).body.code).toBe('validation_failed');

      const updated = await setMode('always');
      await setMode('off_network');

      expect(updated.body.data.clinicalMfa).toBe('always');
      const audits = await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.auditLog.findMany({ where: { action: 'iam.security.policy_updated' }, orderBy: { chainSeq: 'asc' } }));
      expect(audits.map((a) => a.changes)).toEqual([{ clinicalMfa: 'always' }, { clinicalMfa: 'off_network' }]);
    });

    it('prévient les directeurs (e-mail et in-app), jamais l’auteur', async () => {
      const alerts = await notificationsOf('security.policy_changed');

      expect(alerts.length).toBeGreaterThan(0);
      expect(new Set(alerts.map((a) => a.recipientId))).toEqual(new Set([director.userId]));
      expect(new Set(alerts.map((a) => a.channel))).toEqual(new Set(['email', 'inapp']));
    });
  });

  describe('opérations de pouvoir : principal seul et code TOTP (décision 23)', () => {
    it('refuse un administrateur non principal (403 owner_required), même avec un code', async () => {
      const secret = await activateTotp(app, tenant.tenantId, admin2.userId);
      const body = async () => ({ totpCode: await stepUpCode(app, tenant.tenantId, admin2.userId, secret) });

      expect((await http(app).patch(POLICY).set(bearer(admin2.token)).send({ clinicalMfa: 'always', ...(await body()) }).expect(403)).body.code).toBe('owner_required');
      expect((await http(app).post(NETWORKS).set(bearer(admin2.token)).send({ cidr: HOSPITAL_NETWORK, label: 'Siège', ...(await body()) }).expect(403)).body.code).toBe('owner_required');
      const created = await addNetwork(HOSPITAL_NETWORK, 201);
      const removal = await http(app).delete(`${NETWORKS}/${created.body.data.id}`).set(bearer(admin2.token)).send(await body()).expect(403);
      expect(removal.body.code).toBe('owner_required');
      await clearNetworks();
    });

    it('exige le code TOTP (401 mfa_step_up_required) et refuse un code faux (401 mfa_code_invalid)', async () => {
      const wrong = await wrongTotpCode(ownerSecret);

      expect((await http(app).patch(POLICY).set(bearer(tenant.adminToken)).send({ clinicalMfa: 'always' }).expect(401)).body.code).toBe('mfa_step_up_required');
      expect((await http(app).patch(POLICY).set(bearer(tenant.adminToken)).send({ clinicalMfa: 'always', totpCode: wrong }).expect(401)).body.code).toBe('mfa_code_invalid');
      expect((await http(app).post(NETWORKS).set(bearer(tenant.adminToken)).send({ cidr: HOSPITAL_NETWORK, label: 'Siège' }).expect(401)).body.code).toBe('mfa_step_up_required');
      expect((await http(app).post(NETWORKS).set(bearer(tenant.adminToken)).send({ cidr: HOSPITAL_NETWORK, label: 'Siège', totpCode: wrong }).expect(401)).body.code).toBe('mfa_code_invalid');
      const created = await addNetwork(HOSPITAL_NETWORK, 201);
      expect((await http(app).delete(`${NETWORKS}/${created.body.data.id}`).set(bearer(tenant.adminToken)).expect(401)).body.code).toBe('mfa_step_up_required');
      expect((await http(app).delete(`${NETWORKS}/${created.body.data.id}`).set(bearer(tenant.adminToken)).send({ totpCode: wrong }).expect(401)).body.code).toBe('mfa_code_invalid');
      expect((await http(app).get(POLICY).set(bearer(tenant.adminToken)).expect(200)).body.data.clinicalMfa).toBe('off_network');
      await clearNetworks();
    });

    it('refuse le rejeu d’un code déjà utilisé (401 mfa_code_invalid)', async () => {
      const used = await code();
      await http(app).patch(POLICY).set(bearer(tenant.adminToken)).send({ clinicalMfa: 'off_network', totpCode: used }).expect(200);

      const replay = await http(app).patch(POLICY).set(bearer(tenant.adminToken)).send({ clinicalMfa: 'off_network', totpCode: used }).expect(401);

      expect(replay.body.code).toBe('mfa_code_invalid');
    });
  });

  describe('POST/DELETE /iam/security/trusted-networks', () => {
    it('ajoute une plage normalisée, la liste dans la politique, l’audite et prévient les directeurs', async () => {
      const created = await addNetwork('41.82.10.77/24', 201);

      expect(created.body.data).toMatchObject({ cidr: HOSPITAL_NETWORK, label: 'Siège', createdBy: { id: tenant.adminUserId } });
      expect(created.body.data).not.toHaveProperty('siteId');
      const policy = await http(app).get(POLICY).set('X-Forwarded-For', HOSPITAL).set(bearer(tenant.adminToken)).expect(200);
      expect(policy.body.data.trustedNetworks.map((n: { cidr: string }) => n.cidr)).toEqual([HOSPITAL_NETWORK]);
      expect(policy.body.data.requestIpTrusted).toBe(true);
      const audits = await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.auditLog.findMany({ where: { action: 'iam.security.trusted_network_added' } }));
      expect(audits.at(-1)!.changes).toEqual({ cidr: HOSPITAL_NETWORK, label: 'Siège' });
      const alerts = await notificationsOf('security.trusted_network_changed');
      expect(new Set(alerts.map((a) => a.recipientId))).toEqual(new Set([director.userId]));
      await clearNetworks();
    });

    it('accepte une adresse seule en /32 ; un siteId éventuel est ignoré, la plage vaut pour tout l’établissement (décision 26)', async () => {
      const res = await addNetwork('154.124.5.7/32', 201, { siteId: tenant.mainSiteId });

      expect(res.body.data).toMatchObject({ cidr: '154.124.5.7/32' });
      expect(res.body.data).not.toHaveProperty('siteId');
      await clearNetworks();
    });

    it.each([
      ['une valeur mal formée', 'pas-une-plage', 'invalid_cidr'],
      ['une adresse sans préfixe', HOSPITAL, 'invalid_cidr'],
      ['un préfixe IPv4 plus large que /24', '41.82.10.0/23', 'cidr_too_broad'],
      ['un préfixe IPv4 très large', '10.0.0.0/8', 'cidr_too_broad'],
      ['un préfixe IPv6 plus large que /48', '2c0f:f248::/47', 'cidr_too_broad'],
      ['tout le réseau', '0.0.0.0/0', 'cidr_too_broad'],
      ['une plage privée RFC 1918', '192.168.1.0/24', 'cidr_reserved'],
      ['une plage partagée 100.64/10', '100.64.1.0/24', 'cidr_reserved'],
      ['une plage de documentation', '203.0.113.0/24', 'cidr_reserved'],
      ['une plage IPv6 locale unique', 'fd00:1:2::/48', 'cidr_reserved'],
      ['une IPv4 privée encapsulée', '::ffff:10.0.0.0/120', 'cidr_reserved'],
    ])('refuse %s (422 %s)', async (_label, cidr, expected) => {
      const res = await addNetwork(cidr, 422);

      expect(res.body.code).toBe(expected);
    });

    it('refuse un corps invalide (422 validation)', async () => {
      expect((await http(app).post(NETWORKS).set(bearer(tenant.adminToken)).send({ label: 'Siège' }).expect(422)).body.code).toBe('validation_failed');
      expect((await addNetwork(HOSPITAL_NETWORK, 422, { totpCode: '12ab' })).body.code).toBe('validation_failed');
    });

    it('refuse un doublon (409) et plus de 50 plages (422 trusted_network_limit)', async () => {
      await addNetwork(HOSPITAL_NETWORK, 201);
      expect((await addNetwork('41.82.10.200/24', 409)).body.code).toBe('trusted_network_exists');
      await app.get(TenantDb).runAs(tenant.tenantId, (tx) =>
        tx.trustedNetwork.createMany({
          data: Array.from({ length: 49 }, (_v, i) => ({ tenantId: tenant.tenantId, network: `41.${i + 100}.0.0/24`, label: `Plage ${i}` })),
        }),
      );

      const res = await addNetwork('196.1.2.0/24', 422);

      expect(res.body.code).toBe('trusted_network_limit');
      await clearNetworks();
    });

    it('supprime une plage (204, audité), puis 404 ; 404 aussi pour une plage d’un autre établissement', async () => {
      const mine = await addNetwork(HOSPITAL_NETWORK, 201);
      const theirs = await http(app)
        .post(NETWORKS)
        .set(bearer(other.adminToken))
        .send({ cidr: HOSPITAL_NETWORK, label: 'Siège', totpCode: await stepUpCode(app, other.tenantId, other.adminUserId, otherSecret) })
        .expect(201);

      await removeNetwork(mine.body.data.id, 204);
      await removeNetwork(mine.body.data.id, 404);
      await removeNetwork(theirs.body.data.id, 404);
      await removeNetwork('pas-un-uuid', 404);

      const audits = await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.auditLog.findMany({ where: { action: 'iam.security.trusted_network_removed' } }));
      expect(audits).toHaveLength(1);
      await clearNetworks();
    });
  });

  describe('MFA d’un soignant sans second facteur', () => {
    it('refuse hors réseau quand aucune plage n’est déclarée (tous les réseaux sont hors confiance)', async () => {
      await clearNetworks();

      const res = await from(HOSPITAL, doctor.token).expect(403);

      expect(res.body.code).toBe('mfa_enrollment_required');
      expect(res.body.offNetwork).toBe(true);
    });

    it('autorise sur une plage de confiance, et réévalue à chaque requête quand l’IP change (même session)', async () => {
      await addNetwork(HOSPITAL_NETWORK, 201);

      await from(HOSPITAL, doctor.token).expect(200);
      await from(ELSEWHERE, doctor.token).expect(403);
      await from(HOSPITAL, doctor.token).expect(200);
      await from(`::ffff:${HOSPITAL}`, doctor.token).expect(200);
    });

    it('reflète la règle dans /auth/me pour l’IP courante', async () => {
      const onSite = await http(app).get(`${AUTH}/me`).set('X-Forwarded-For', HOSPITAL).set(bearer(doctor.token)).expect(200);
      const away = await http(app).get(`${AUTH}/me`).set('X-Forwarded-For', ELSEWHERE).set(bearer(doctor.token)).expect(200);

      expect(onSite.body.data.mfa).toMatchObject({ enrolled: false, verified: false, required: false });
      expect(away.body.data.mfa).toMatchObject({ required: true });
    });

    it('trace le refus dans l’audit avec offNetwork', async () => {
      await from(ELSEWHERE, doctor.token).expect(403);

      const denied = await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.auditLog.findMany({ where: { action: 'authz.denied', actorUserId: doctor.userId }, orderBy: { chainSeq: 'desc' }, take: 1 }));
      expect(denied[0]!.changes).toMatchObject({ reason: 'mfa_enrollment_required', offNetwork: true });
    });

    it('refuse aussi sur le réseau de confiance en mode always (offNetwork: false)', async () => {
      await setMode('always');

      const res = await from(HOSPITAL, doctor.token).expect(403);
      await setMode('off_network');

      expect(res.body.code).toBe('mfa_enrollment_required');
      expect(res.body.offNetwork).toBe(false);
      await from(HOSPITAL, doctor.token).expect(200);
    });

    it('un soignant dont la session est vérifiée par MFA n’est pas concerné', async () => {
      const verified = await createUserWithRole(app, tenant, 'doctor', { scopeType: 'tenant' }, true);

      await from(ELSEWHERE, verified.token).expect(200);
    });

    it('trace offNetwork dans l’audit d’une lecture de dossier hors réseau, pas sur le réseau de confiance (§14.2.11)', async () => {
      await clearNetworks();
      await addNetwork(HOSPITAL_NETWORK, 201);
      const verified = await createUserWithRole(app, tenant, 'doctor', { scopeType: 'tenant' }, true);
      const patientId = await createPatientWithContacts(app, tenant);
      const read = (ip: string) => http(app).get(`/api/v1/patients/${patientId}`).set('X-Forwarded-For', ip).set(bearer(verified.token)).expect(200);

      await read(HOSPITAL);
      await read(ELSEWHERE);

      const reads = await app.get(TenantDb).runAs(tenant.tenantId, (tx) =>
        tx.auditLog.findMany({ where: { action: 'patient.read', patientId }, orderBy: { chainSeq: 'asc' }, select: { changes: true } }),
      );
      expect(reads.map((row) => row.changes)).toEqual([null, { offNetwork: true }]);
    });

    it('ne concerne jamais un utilisateur non clinique, même en mode always', async () => {
      await setMode('always');

      await from(ELSEWHERE, cashier.token).expect(200);
      await setMode('off_network');
    });

    it('un rôle personnalisé portant une permission clinique est couvert (calcul sur les permissions effectives)', async () => {
      const { createUserWithPermissions } = await import('../helpers/fixtures');
      const custom = await createUserWithPermissions(app, tenant, ['org:site:read', 'laboratory:order:read'], { scopeType: 'tenant' }, false);

      const res = await from(ELSEWHERE, custom.token).expect(403);

      expect(res.body.code).toBe('mfa_enrollment_required');
    });

    it('le gestionnaire de stock (permissions de stock pharmacie) n’est pas clinique (décision 22)', async () => {
      const storekeeper = await createUserWithRole(app, tenant, 'stock_manager', { scopeType: 'tenant' }, false);

      await from(ELSEWHERE, storekeeper.token).expect(200);
    });
  });

  it('refuse l’IP absente, invalide ou privée comme hors réseau de confiance', async () => {
    await http(app).get(ROUTE).set(bearer(doctor.token)).expect(403);
    const res = await from('10.1.2.3', doctor.token).expect(403);

    expect(res.body.code).toBe('mfa_enrollment_required');
  });

  describe('clinicalUsersWithoutMfa', () => {
    it('compte les utilisateurs actifs à rôle clinique sans TOTP actif', async () => {
      const t = await createTenantFixture(app, { prefix: 'net-count' });
      const [withoutMfa, withMfa, disabled] = await Promise.all([
        createUserWithRole(app, t, 'doctor'),
        createUserWithRole(app, t, 'nurse'),
        createUserWithRole(app, t, 'receptionist'),
        createUserWithRole(app, t, 'cashier'),
        createUserWithRole(app, t, 'stock_manager'),
      ]);
      await activateTotp(app, t.tenantId, withMfa.userId);
      await app.get(TenantDb).runAs(t.tenantId, (tx) => tx.user.update({ where: { tenantId_id: { tenantId: t.tenantId, id: disabled.userId } }, data: { status: 'disabled' } }));

      const res = await http(app).get(POLICY).set(bearer(t.adminToken)).expect(200);

      expect(withoutMfa.userId).toBeDefined();
      expect(res.body.data.clinicalUsersWithoutMfa).toBe(1);
    });
  });
});
