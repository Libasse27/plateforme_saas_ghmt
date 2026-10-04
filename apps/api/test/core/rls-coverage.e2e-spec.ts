import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

/** Lit le catalogue PostgreSQL avec le rôle applicatif : aucune table `tenant.*` ne doit échapper au RLS. */
describe('isolation : couverture RLS de toutes les tables tenant (L8)', () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env['DATABASE_URL'] });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
  });

  it('trouve les tables du schéma tenant (garde-fou contre un test vide)', async () => {
    const { rows } = await client.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'tenant' AND c.relkind IN ('r', 'p') AND NOT c.relispartition`,
    );

    const tables = rows.map((r) => r.relname);
    expect(tables.length).toBeGreaterThanOrEqual(15);
    expect(tables).toEqual(expect.arrayContaining(['users', 'patients', 'appointments', 'audit_logs', 'invitations']));
  });

  it('active ET force le RLS sur chaque table tenant.*', async () => {
    const { rows } = await client.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'tenant' AND c.relkind IN ('r', 'p') AND NOT c.relispartition`,
    );

    const notEnabled = rows.filter((r) => !r.relrowsecurity).map((r) => r.relname);
    const notForced = rows.filter((r) => !r.relforcerowsecurity).map((r) => r.relname);
    expect(notEnabled, `tables sans ENABLE ROW LEVEL SECURITY : ${notEnabled.join(', ')}`).toEqual([]);
    expect(notForced, `tables sans FORCE ROW LEVEL SECURITY : ${notForced.join(', ')}`).toEqual([]);
  });

  it('porte une colonne tenant_id uuid sur chaque table tenant.*', async () => {
    const { rows } = await client.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'tenant' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
         AND NOT EXISTS (
           SELECT 1 FROM pg_attribute a
           WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0 AND NOT a.attisdropped
             AND a.atttypid = 'uuid'::regtype
         )`,
    );

    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it('applique la politique tenant_isolation (USING et WITH CHECK) sur chaque table tenant.*', async () => {
    const { rows } = await client.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'tenant' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
         AND NOT EXISTS (
           SELECT 1 FROM pg_policies p
           WHERE p.schemaname = 'tenant' AND p.tablename = c.relname AND p.policyname = 'tenant_isolation'
             AND p.qual IS NOT NULL AND p.with_check IS NOT NULL
         )`,
    );

    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it('n’accorde au rôle applicatif ni la propriété des tables ni le droit de contourner le RLS', async () => {
    const { rows } = await client.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
      `SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`,
    );
    const owned = await client.query(
      `SELECT 1 FROM pg_tables WHERE schemaname = 'tenant' AND tableowner = current_user`,
    );

    expect(rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
    expect(owned.rowCount).toBe(0);
  });

  it('accorde le DML au rôle applicatif sur chaque table tenant.*, sauf UPDATE/DELETE sur le journal d’audit', async () => {
    const { rows } = await client.query<{ relname: string; can_select: boolean; can_insert: boolean; can_update: boolean; can_delete: boolean }>(
      `SELECT c.relname,
              has_table_privilege(current_user, c.oid, 'SELECT') AS can_select,
              has_table_privilege(current_user, c.oid, 'INSERT') AS can_insert,
              has_table_privilege(current_user, c.oid, 'UPDATE') AS can_update,
              has_table_privilege(current_user, c.oid, 'DELETE') AS can_delete
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'tenant' AND c.relkind IN ('r', 'p') AND NOT c.relispartition`,
    );

    for (const row of rows) {
      expect(row.can_select && row.can_insert, row.relname).toBe(true);
      const appendOnly = row.relname === 'audit_logs';
      expect(row.can_update, `${row.relname} UPDATE`).toBe(!appendOnly);
      expect(row.can_delete, `${row.relname} DELETE`).toBe(!appendOnly);
    }
  });
});
