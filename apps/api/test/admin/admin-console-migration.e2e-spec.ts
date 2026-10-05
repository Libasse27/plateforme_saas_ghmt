import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTenantFixture, type TenantFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { auditRows, bearer, http } from './admin-fixtures';

const MIGRATION_SQL = readFileSync(resolve(__dirname, '../../prisma/migrations/20261005000500_admin_console/migration.sql'), 'utf8');
const CATCH_UP: readonly (readonly [string, string])[] = [
  ['tenant_admin', 'audit:log:export'],
  ['tenant_admin', 'settings:notification_log:read'],
  ['director', 'settings:notification_log:read'],
];

describe('migration 20261005000500_admin_console : rattrapage des rôles système', () => {
  let app: INestApplication;
  let client: pg.Client;
  let tenant: TenantFixture;

  /** Exécute `work` dans une transaction du propriétaire avec le contexte RLS du tenant. */
  async function asTenant<T>(work: () => Promise<T>): Promise<T> {
    await client.query('BEGIN');
    try {
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant.tenantId]);
      const result = await work();
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  const grantedPairs = (): Promise<string[]> =>
    asTenant(async () => {
      const { rows } = await client.query<{ template_code: string; permission_code: string }>(
        `SELECT r.template_code, rp.permission_code FROM tenant.role_permissions rp
         JOIN tenant.roles r ON r.tenant_id = rp.tenant_id AND r.id = rp.role_id
         WHERE rp.permission_code IN ('audit:log:export', 'settings:notification_log:read') AND r.is_system
         ORDER BY 1, 2`,
      );
      return rows.map((row) => `${row.template_code}|${row.permission_code}`);
    });

  const removeAdminExport = (): Promise<unknown> =>
    asTenant(() =>
      client.query(
        `DELETE FROM tenant.role_permissions WHERE permission_code = 'audit:log:export'
         AND role_id IN (SELECT id FROM tenant.roles WHERE template_code = 'tenant_admin')`,
      ),
    );

  beforeAll(async () => {
    app = await createTestApp();
    tenant = await createTenantFixture(app, { prefix: 'mig' });
    client = new pg.Client({ connectionString: process.env['MIGRATION_DATABASE_URL'] });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
    await app?.close();
  });

  it('simule un établissement antérieur à la phase : les permissions de rattrapage sont retirées', async () => {
    await asTenant(() => client.query("DELETE FROM tenant.role_permissions WHERE permission_code = 'settings:notification_log:read'"));
    await removeAdminExport();

    expect(await grantedPairs()).toEqual([]);
  });

  it('applique la migration : tenant_admin reçoit audit:log:export et le journal des envois, director le journal des envois', async () => {
    await client.query(MIGRATION_SQL);

    expect(await grantedPairs()).toEqual(CATCH_UP.map(([role, permission]) => `${role}|${permission}`).sort());
  });

  it('est idempotente : une seconde application ne produit ni erreur ni doublon', async () => {
    const before = await grantedPairs();

    await client.query(MIGRATION_SQL);

    expect(await grantedPairs()).toEqual(before);
  });

  it('n’accorde rien aux rôles système supprimés', async () => {
    await asTenant(async () => {
      await client.query("UPDATE tenant.roles SET deleted_at = now() WHERE code = 'director'");
      await client.query("DELETE FROM tenant.role_permissions WHERE permission_code = 'settings:notification_log:read'");
    });

    await client.query(MIGRATION_SQL);

    expect(await grantedPairs()).toEqual(['tenant_admin|audit:log:export', 'tenant_admin|settings:notification_log:read']);
  });

  it('crée la permission du journal des envois et l’index du filtre d’action', async () => {
    const permission = await client.query("SELECT 1 FROM platform.permissions WHERE code = 'settings:notification_log:read'");
    const index = await client.query("SELECT 1 FROM pg_indexes WHERE schemaname = 'tenant' AND indexname = 'ix_audit_logs_action'");

    expect(permission.rowCount).toBe(1);
    expect(index.rowCount).toBe(1);
  });

  it('restaure le contexte tenant d’origine après le bloc DO (aucune fuite de contexte)', async () => {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant.tenantId]);
    await client.query(MIGRATION_SQL);
    const { rows } = await client.query<{ value: string }>("SELECT current_setting('app.tenant_id', true) AS value");
    await client.query('ROLLBACK');

    expect(rows[0]!.value).toBe(tenant.tenantId);
  });

  it('un établissement créé avant la migration peut exporter le journal une fois la migration appliquée (test de fumée)', async () => {
    await removeAdminExport();
    const denied = await http(app).post('/api/v1/audit-logs/export').set(bearer({ token: tenant.adminToken })).send({});
    await client.query(MIGRATION_SQL);

    const allowed = await http(app).post('/api/v1/audit-logs/export').set(bearer({ token: tenant.adminToken })).send({});

    expect(denied.status).toBe(403);
    expect(allowed.status).toBe(200);
    expect((await auditRows(app, tenant, 'audit.logs_exported')).length).toBeGreaterThanOrEqual(1);
  });
});
