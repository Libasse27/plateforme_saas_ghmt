import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { createTenantFixture, createUserWithRole, type TenantFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';

const MIGRATION = resolve(__dirname, '../../prisma/migrations/20261006000100_auth_hardening/migration.sql');
const CATCH_UP_MARKER = '-- ───────── 7. Rattrapage';

describe('migration 20261006000100_auth_hardening', () => {
  let app: INestApplication;
  let tenant: TenantFixture;
  let other: TenantFixture;
  let owner: pg.Client;

  const db = () => app.get(TenantDb);
  const settingsOf = (t: TenantFixture) => db().runAs(t.tenantId, (tx) => tx.securitySettings.findFirst());

  beforeAll(async () => {
    app = await createTestApp();
    [tenant, other] = await Promise.all([createTenantFixture(app, { prefix: 'mig' }), createTenantFixture(app, { prefix: 'mig-b' })]);
    owner = new pg.Client({ connectionString: process.env['MIGRATION_DATABASE_URL'] });
    await owner.connect();
  });

  afterAll(async () => {
    await owner?.end();
    await app?.close();
  });

  describe('trigger du principal', () => {
    it('pose l’administrateur du tenant créé par provision comme principal, avec le mode par défaut', async () => {
      expect(await settingsOf(tenant)).toMatchObject({ ownerUserId: tenant.adminUserId, clinicalMfaMode: 'off_network' });
    });

    it('ne change pas le principal à une affectation tenant_admin ultérieure', async () => {
      await createUserWithRole(app, tenant, 'tenant_admin');

      expect((await settingsOf(tenant))!.ownerUserId).toBe(tenant.adminUserId);
    });

    it('ne s’active ni pour un autre rôle ni pour une portée de site', async () => {
      const t = await createTenantFixture(app, { prefix: 'mig-c' });
      await db().runAs(t.tenantId, (tx) => tx.securitySettings.deleteMany({}));

      await createUserWithRole(app, t, 'doctor');
      expect(await settingsOf(t)).toBeNull();
      await createUserWithRole(app, t, 'tenant_admin', { scopeType: 'site', scopeId: t.mainSiteId });
      expect(await settingsOf(t)).toBeNull();

      const admin = await createUserWithRole(app, t, 'tenant_admin');
      expect((await settingsOf(t))!.ownerUserId).toBe(admin.userId);
    });

    it('complète une ligne existante sans principal (politique modifiée avant toute affectation)', async () => {
      const t = await createTenantFixture(app, { prefix: 'mig-d' });
      await db().runAs(t.tenantId, (tx) => tx.securitySettings.update({ where: { tenantId: t.tenantId }, data: { ownerUserId: null, clinicalMfaMode: 'always' } }));

      const admin = await createUserWithRole(app, t, 'tenant_admin');

      expect(await settingsOf(t)).toMatchObject({ ownerUserId: admin.userId, clinicalMfaMode: 'always' });
    });
  });

  describe('rattrapage des établissements existants', () => {
    it('désigne l’administrateur actif le plus ancien et remet locked_until à NULL', async () => {
      const t = await createTenantFixture(app, { prefix: 'mig-e' });
      const later = await createUserWithRole(app, t, 'tenant_admin');
      await db().runAs(t.tenantId, async (tx) => {
        await tx.securitySettings.deleteMany({});
        await tx.userCredential.update({ where: { tenantId_userId: { tenantId: t.tenantId, userId: later.userId } }, data: { lockedUntil: new Date(Date.now() + 3_600_000) } });
      });
      const script = readFileSync(MIGRATION, 'utf8');
      const catchUp = script.slice(script.indexOf(CATCH_UP_MARKER));

      await owner.query(catchUp);

      expect((await settingsOf(t))!.ownerUserId).toBe(t.adminUserId);
      const credential = await db().runAs(t.tenantId, (tx) => tx.userCredential.findUniqueOrThrow({ where: { tenantId_userId: { tenantId: t.tenantId, userId: later.userId } } }));
      expect(credential.lockedUntil).toBeNull();
    });

    it('ignore un administrateur désactivé et laisse intacte une politique déjà posée', async () => {
      const t = await createTenantFixture(app, { prefix: 'mig-f' });
      const script = readFileSync(MIGRATION, 'utf8');
      const catchUp = script.slice(script.indexOf(CATCH_UP_MARKER));
      await db().runAs(t.tenantId, (tx) => tx.securitySettings.update({ where: { tenantId: t.tenantId }, data: { clinicalMfaMode: 'always' } }));

      await owner.query(catchUp);

      expect(await settingsOf(t)).toMatchObject({ ownerUserId: t.adminUserId, clinicalMfaMode: 'always' });
    });
  });

  describe('contraintes SQL', () => {
    const insertNetwork = (t: TenantFixture, network: string) =>
      db().runAs(t.tenantId, (tx) => tx.$executeRaw`INSERT INTO tenant.trusted_networks (id, tenant_id, network, label) VALUES (gen_random_uuid(), ${t.tenantId}::uuid, ${network}::inet, 'essai')`);

    it.each([
      ['un préfixe IPv4 inférieur à /16', '10.0.0.0/8', 'ck_trusted_networks_prefix'],
      ['un préfixe IPv6 inférieur à /32', '2001::/16', 'ck_trusted_networks_prefix'],
      ['une forme non normalisée (bits d’hôte)', '203.0.113.7/24', 'ck_trusted_networks_normalized'],
    ])('refuse %s', async (_label, network, constraint) => {
      await expect(insertNetwork(tenant, network)).rejects.toThrow(new RegExp(`${constraint}|23514`));
    });

    it('refuse un mode MFA inconnu et un doublon actif, accepte les plages normalisées', async () => {
      await expect(db().runAs(tenant.tenantId, (tx) => tx.securitySettings.update({ where: { tenantId: tenant.tenantId }, data: { clinicalMfaMode: 'disabled' } }))).rejects.toThrow();
      await insertNetwork(tenant, '203.0.113.0/24');
      await insertNetwork(tenant, '2001:db8::/32');
      await expect(insertNetwork(tenant, '203.0.113.0/24')).rejects.toThrow();
    });

    it('isole les tables par établissement (RLS)', async () => {
      await insertNetwork(other, '198.51.100.0/24');

      const mine = await db().runAs(tenant.tenantId, (tx) => tx.$queryRaw<{ network: string }[]>`SELECT host(network) AS network FROM tenant.trusted_networks`);

      expect(mine.map((r) => r.network)).not.toContain('198.51.100.0');
      const sees = await db().runAs(other.tenantId, (tx) => tx.securitySettings.findMany());
      expect(sees.map((s) => s.tenantId)).toEqual([other.tenantId]);
    });
  });
});
