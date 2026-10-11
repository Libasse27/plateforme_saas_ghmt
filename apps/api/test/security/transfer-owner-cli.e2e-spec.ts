import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CliError, assertTerminal, parseCliArgs, runCli, transferTenantOwner, type TransferParams } from '../../scripts/transfer-tenant-owner.mts';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { bearer, http } from '../auth/auth-helpers';
import { createTenantFixture, createUserWithRole, issueToken, type TenantFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { activateTotp } from '../iam/support';

const run = promisify(execFile);
const API_ROOT = resolve(__dirname, '../..');
const OPERATOR = 'Awa Diop (astreinte)';
const REASON = 'Demande écrite de la direction du 2026-10-09, principal parti.';
const ORIGIN = { osUser: 'exploitation', host: 'bastion-01' };
const OPTIONS = ['--operator', OPERATOR, '--reason', REASON];

describe('script transfer-tenant-owner.mts (docs/11 §5.7, §14.2 point 9)', () => {
  let app: INestApplication;
  let client: pg.Client;
  let tenant: TenantFixture;

  const db = () => app.get(TenantDb);
  const ownerOf = async (t: TenantFixture = tenant): Promise<string | null> => (await db().runAs(t.tenantId, (tx) => tx.securitySettings.findFirst()))?.ownerUserId ?? null;
  const params = (t: TenantFixture, email: string, extra: Partial<TransferParams> = {}): TransferParams => ({
    slug: t.slug,
    email,
    operator: OPERATOR,
    reason: REASON,
    allowWithoutTotp: false,
    grantAdmin: false,
    ...extra,
  });
  const auditsOf = (t: TenantFixture, action: string) => db().runAs(t.tenantId, (tx) => tx.auditLog.findMany({ where: { action }, orderBy: { chainSeq: 'asc' } }));

  beforeAll(async () => {
    app = await createTestApp();
    client = new pg.Client({ connectionString: process.env['MIGRATION_DATABASE_URL'] });
    await client.connect();
    tenant = await createTenantFixture(app, { prefix: 'cli-owner' });
  });

  afterAll(async () => {
    await client?.end();
    await app?.close();
  });

  describe('arguments et terminal', () => {
    it('analyse le code établissement, l’e-mail (normalisés), l’opérateur, le motif et les options', () => {
      expect(parseCliArgs(['--tenant', 'Clinique-A', '--email', ' Awa@Test.SN ', ...OPTIONS])).toEqual({
        slug: 'clinique-a',
        email: 'awa@test.sn',
        operator: OPERATOR,
        reason: REASON,
        allowWithoutTotp: false,
        grantAdmin: false,
      });
      expect(parseCliArgs(['--tenant', 'clinique-a', '--email', 'a@b.sn', ...OPTIONS, '--allow-without-totp', '--grant-admin'])).toMatchObject({ allowWithoutTotp: true, grantAdmin: true });
    });

    it.each([
      [['--email', 'a@b.sn', ...OPTIONS]],
      [['--tenant', 'clinique-a', ...OPTIONS]],
      [['--tenant', 'A B', '--email', 'a@b.sn', ...OPTIONS]],
      [['--tenant', 'clinique-a', '--email', 'pas-un-email', ...OPTIONS]],
      [['--tenant', 'clinique-a', '--email', 'a@b.sn', '--reason', REASON]],
      [['--tenant', 'clinique-a', '--email', 'a@b.sn', '--operator', OPERATOR]],
      [['--tenant', 'clinique-a', '--email', 'a@b.sn', '--operator', 'X', '--reason', REASON]],
      [['--tenant', 'clinique-a', '--email', 'a@b.sn', '--operator', OPERATOR, '--reason', 'court']],
      [['--tenant', 'clinique-a', '--email', 'a@b.sn', '--operator', OPERATOR, '--reason', 'x'.repeat(501)]],
    ])('refuse des arguments invalides (%j)', (argv) => {
      expect(() => parseCliArgs(argv)).toThrow(CliError);
    });

    it('refuse quand la sortie standard n’est pas un terminal, avant toute connexion', async () => {
      expect(() => assertTerminal({ isTTY: false })).toThrow(CliError);
      expect(() => assertTerminal({})).toThrow(CliError);
      expect(() => assertTerminal({ isTTY: true })).not.toThrow();
      const writes: string[] = [];
      await expect(runCli(['--tenant', tenant.slug, '--email', tenant.adminEmail, ...OPTIONS], { stdout: { write: (t) => writes.push(t), isTTY: false }, env: {} })).rejects.toThrow(CliError);
      expect(writes).toEqual([]);
    });

    it('refuse en ligne de commande quand stdout est redirigé (code de sortie 1, aucun transfert)', async () => {
      const heir = await createUserWithRole(app, tenant, 'tenant_admin');
      const before = await ownerOf();

      await expect(
        run(process.execPath, ['scripts/transfer-tenant-owner.mts', '--tenant', tenant.slug, '--email', heir.email, ...OPTIONS], { cwd: API_ROOT, env: process.env }),
      ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('terminal') });

      expect(await ownerOf()).toBe(before);
    });
  });

  describe('transfert', () => {
    it('désigne un administrateur actif avec TOTP, audite opérateur, motif, utilisateur OS et hôte, sans rompre la chaîne', async () => {
      const heir = await createUserWithRole(app, tenant, 'tenant_admin');
      await activateTotp(app, tenant.tenantId, heir.userId);
      const output: string[] = [];

      const result = await runCli(['--tenant', tenant.slug, '--email', heir.email, ...OPTIONS], { stdout: { write: (t) => output.push(t), isTTY: true }, env: process.env });

      expect(result).toMatchObject({ tenantId: tenant.tenantId, fromUserId: tenant.adminUserId, toUserId: heir.userId, grantedAdmin: false });
      expect(await ownerOf()).toBe(heir.userId);
      expect(output.join('')).toContain(tenant.slug);
      const audits = await auditsOf(tenant, 'iam.owner.transferred');
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        actorType: 'system',
        actorUserId: null,
        changes: { via: 'cli', toUserId: heir.userId, fromUserId: tenant.adminUserId, operator: OPERATOR, reason: REASON, allowWithoutTotp: false, osUser: expect.any(String), host: expect.any(String) },
      });
      // La chaîne reste vérifiable après l'écriture hors application.
      const verify = await http(app).get('/api/v1/audit-logs/verify').query({ limit: 1000 }).set(bearer(tenant.adminToken)).expect(200);
      expect(verify.body.data).toMatchObject({ status: 'intact' });
    });

    it('refuse un utilisateur désactivé, non administrateur ou inconnu, et un établissement inconnu', async () => {
      const doctor = await createUserWithRole(app, tenant, 'doctor');
      const disabled = await createUserWithRole(app, tenant, 'tenant_admin');
      await activateTotp(app, tenant.tenantId, disabled.userId);
      await db().runAs(tenant.tenantId, (tx) => tx.user.update({ where: { tenantId_id: { tenantId: tenant.tenantId, id: disabled.userId } }, data: { status: 'disabled' } }));
      const before = await ownerOf();

      for (const email of [doctor.email, disabled.email, 'inconnu@nowhere.test']) {
        await expect(transferTenantOwner(client, params(tenant, email), ORIGIN)).rejects.toThrow(CliError);
      }
      await expect(transferTenantOwner(client, { ...params(tenant, doctor.email), slug: 'etablissement-fantome' }, ORIGIN)).rejects.toThrow(CliError);

      expect(await ownerOf()).toBe(before);
    });

    it('exige un TOTP actif, sauf --allow-without-totp (journalisé dans l’audit)', async () => {
      const t = await createTenantFixture(app, { prefix: 'cli-owner-totp' });
      const heir = await createUserWithRole(app, t, 'tenant_admin');

      await expect(transferTenantOwner(client, params(t, heir.email), ORIGIN)).rejects.toThrow(/second facteur/);
      expect(await ownerOf(t)).toBe(t.adminUserId);

      await transferTenantOwner(client, params(t, heir.email, { allowWithoutTotp: true }), ORIGIN);

      expect(await ownerOf(t)).toBe(heir.userId);
      expect((await auditsOf(t, 'iam.owner.transferred'))[0]!.changes).toMatchObject({ allowWithoutTotp: true, osUser: ORIGIN.osUser, host: ORIGIN.host });
    });

    it('exige le rôle système tenant_admin (is_system)', async () => {
      const t = await createTenantFixture(app, { prefix: 'cli-owner-sys' });
      const heir = await createUserWithRole(app, t, 'tenant_admin');
      await activateTotp(app, t.tenantId, heir.userId);
      await db().runAs(t.tenantId, (tx) => tx.role.updateMany({ where: { code: 'tenant_admin' }, data: { isSystem: false } }));

      await expect(transferTenantOwner(client, params(t, heir.email), ORIGIN)).rejects.toThrow(CliError);

      expect(await ownerOf(t)).toBe(t.adminUserId);
    });

    it('fonctionne sans principal préalable (ligne de politique créée)', async () => {
      const t = await createTenantFixture(app, { prefix: 'cli-owner-b' });
      await activateTotp(app, t.tenantId, t.adminUserId);
      await db().runAs(t.tenantId, (tx) => tx.securitySettings.deleteMany({}));

      const result = await transferTenantOwner(client, params(t, t.adminEmail), ORIGIN);

      expect(result).toMatchObject({ fromUserId: null, toUserId: t.adminUserId });
    });

    it('prévient les directeurs et le nouveau principal (e-mail et in-app)', async () => {
      const t = await createTenantFixture(app, { prefix: 'cli-owner-notif' });
      const [heir, director] = await Promise.all([createUserWithRole(app, t, 'tenant_admin'), createUserWithRole(app, t, 'director')]);
      await activateTotp(app, t.tenantId, heir.userId);

      await transferTenantOwner(client, params(t, heir.email), ORIGIN);

      const alerts = await db().runAs(t.tenantId, (tx) => tx.notification.findMany({ where: { typeCode: 'security.owner_transferred' }, select: { recipientId: true, channel: true, status: true, context: true } }));
      expect(new Set(alerts.map((a) => a.recipientId))).toEqual(new Set([director.userId, heir.userId]));
      expect(new Set(alerts.map((a) => a.channel))).toEqual(new Set(['email', 'inapp']));
      expect(alerts.every((a) => a.status === 'queued')).toBe(true);
      expect(alerts[0]!.context).toMatchObject({ targetUserId: heir.userId });
    });
  });

  describe('--grant-admin', () => {
    const withoutAdmin = async (prefix: string) => {
      const t = await createTenantFixture(app, { prefix });
      const heir = await createUserWithRole(app, t, 'doctor');
      await activateTotp(app, t.tenantId, heir.userId);
      await db().runAs(t.tenantId, (tx) => tx.user.update({ where: { tenantId_id: { tenantId: t.tenantId, id: t.adminUserId } }, data: { status: 'disabled' } }));
      return { t, heir };
    };

    it('affecte tenant_admin (audité, acteur system) quand aucun administrateur actif n’existe', async () => {
      const { t, heir } = await withoutAdmin('cli-owner-grant');

      await expect(transferTenantOwner(client, params(t, heir.email), ORIGIN)).rejects.toThrow(CliError);
      const result = await transferTenantOwner(client, params(t, heir.email, { grantAdmin: true }), ORIGIN);

      expect(result).toMatchObject({ toUserId: heir.userId, grantedAdmin: true });
      expect(await ownerOf(t)).toBe(heir.userId);
      const granted = await auditsOf(t, 'iam.assignment.created');
      expect(granted.at(-1)).toMatchObject({ actorType: 'system', changes: { userId: heir.userId, after: { roleCode: 'tenant_admin', scopeType: 'tenant' }, via: 'cli', operator: OPERATOR } });
      // Le nouvel administrateur accède à l'audit : la chaîne reste intacte après les deux maillons écrits par le script.
      const token = await issueToken(app, t.tenantId, heir.userId);
      const verify = await http(app).get('/api/v1/audit-logs/verify').query({ limit: 1000 }).set(bearer(token)).expect(200);
      expect(verify.body.data).toMatchObject({ status: 'intact' });
    });

    it('refuse --grant-admin quand un administrateur actif existe', async () => {
      const t = await createTenantFixture(app, { prefix: 'cli-owner-nogrant' });
      const doctor = await createUserWithRole(app, t, 'doctor');
      await activateTotp(app, t.tenantId, doctor.userId);

      await expect(transferTenantOwner(client, params(t, doctor.email, { grantAdmin: true }), ORIGIN)).rejects.toThrow(/administrateur/);

      expect(await ownerOf(t)).toBe(t.adminUserId);
    });
  });
});
