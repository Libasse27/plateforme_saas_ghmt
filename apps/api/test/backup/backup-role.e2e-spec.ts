import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTenantFixture, type TenantFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';

/**
 * docs/13 §3.2 et §11.3 point 1 : rôle `ghmt_backup` (sauvegarde logique, D9).
 * Lecture de tout, sans contexte de tenant (BYPASSRLS), et aucune écriture.
 */
const MIGRATION_SQL = readFileSync(resolve(__dirname, '../../prisma/migrations/20261012000200_backup_role/migration.sql'), 'utf8');
const SCHEMAS = ['platform', 'tenant', 'public'] as const;
const DEV_BACKUP_PASSWORD = 'ghmt_backup_dev';

/** Chaîne de connexion du rôle de sauvegarde : variable dédiée, sinon dérivée de DATABASE_URL (mot de passe de dev, 01-roles.sql). */
function backupUrl(): string {
  const explicit = process.env['BACKUP_DATABASE_URL'];
  if (explicit) return explicit;
  const url = new URL(process.env['DATABASE_URL']!);
  url.username = 'ghmt_backup';
  url.password = DEV_BACKUP_PASSWORD;
  return url.toString();
}

async function connect(connectionString: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}

/** Code SQLSTATE de l'erreur levée par `work`, ou `null` si aucune erreur. */
async function sqlState(work: () => Promise<unknown>): Promise<string | null> {
  try {
    await work();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown';
  }
}

describe('migration 20261012000200_backup_role : rôle ghmt_backup', () => {
  let app: INestApplication;
  let tenant: TenantFixture;
  let backup: pg.Client;
  let migrator: pg.Client;

  beforeAll(async () => {
    app = await createTestApp();
    tenant = await createTenantFixture(app, { prefix: 'bkp' });
    backup = await connect(backupUrl());
    migrator = await connect(process.env['MIGRATION_DATABASE_URL']!);
  });

  afterAll(async () => {
    await backup?.end();
    await migrator?.end();
    await app?.close();
  });

  it('a les attributs LOGIN BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE', async () => {
    const { rows } = await backup.query<Record<string, boolean>>(
      `SELECT rolcanlogin, rolbypassrls, rolsuper, rolcreatedb, rolcreaterole, rolreplication
       FROM pg_roles WHERE rolname = current_user`,
    );
    expect(rows[0]).toEqual({
      rolcanlogin: true,
      rolbypassrls: true,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
    });
  });

  it('lit toutes les tables du schéma tenant sans contexte, y compris les lignes du tenant de test', async () => {
    const { rows: tables } = await backup.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'tenant' AND c.relkind IN ('r', 'p') AND NOT c.relispartition ORDER BY 1`,
    );
    expect(tables.length).toBeGreaterThanOrEqual(15);

    const counts = new Map<string, number>();
    for (const { relname } of tables) {
      const { rows } = await backup.query<{ n: string }>(
        `SELECT count(*) AS n FROM tenant.${pg.escapeIdentifier(relname)} WHERE tenant_id = $1`,
        [tenant.tenantId],
      );
      counts.set(relname, Number(rows[0]!.n));
    }
    // Le provisionnement crée au moins l'administrateur, ses rôles et des maillons d'audit.
    expect(counts.get('users')).toBeGreaterThanOrEqual(1);
    expect(counts.get('roles')).toBeGreaterThanOrEqual(1);
    expect(counts.get('audit_logs')).toBeGreaterThanOrEqual(1);
  });

  it('a SELECT et rien d’autre sur chaque table et séquence de platform, tenant et public', async () => {
    const { rows } = await backup.query<{ rel: string; kind: string; sel: boolean; writes: boolean }>(
      `SELECT format('%I.%I', n.nspname, c.relname) AS rel, c.relkind::text AS kind,
              has_table_privilege(c.oid, 'SELECT') AS sel,
              CASE WHEN c.relkind = 'S' THEN has_sequence_privilege(c.oid, 'USAGE') OR has_sequence_privilege(c.oid, 'UPDATE')
                   ELSE has_table_privilege(c.oid, 'INSERT') OR has_table_privilege(c.oid, 'UPDATE')
                     OR has_table_privilege(c.oid, 'DELETE') OR has_table_privilege(c.oid, 'TRUNCATE')
                     OR has_table_privilege(c.oid, 'REFERENCES') OR has_table_privilege(c.oid, 'TRIGGER') END AS writes
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = ANY($1) AND c.relkind IN ('r', 'p', 'S', 'v', 'm')`,
      [SCHEMAS],
    );
    expect(rows.some((r) => r.rel === 'public._prisma_migrations')).toBe(true);
    expect(rows.filter((r) => !r.sel).map((r) => r.rel)).toEqual([]);
    expect(rows.filter((r) => r.writes).map((r) => r.rel)).toEqual([]);
  });

  it('refuse toute écriture : INSERT, UPDATE, DELETE, TRUNCATE et DDL', async () => {
    const userId = tenant.adminUserId;
    expect(await sqlState(() => backup.query(`UPDATE tenant.users SET full_name = 'x' WHERE id = $1`, [userId]))).toBe('42501');
    expect(await sqlState(() => backup.query(`DELETE FROM tenant.audit_logs WHERE tenant_id = $1`, [tenant.tenantId]))).toBe('42501');
    expect(await sqlState(() => backup.query(`TRUNCATE tenant.audit_logs`))).toBe('42501');
    expect(await sqlState(() => backup.query(`INSERT INTO platform.audit_logs (id) VALUES (gen_random_uuid())`))).toBe('42501');
    expect(await sqlState(() => backup.query(`DELETE FROM public._prisma_migrations`))).toBe('42501');
    expect(await sqlState(() => backup.query(`CREATE TABLE tenant.zz_backup_probe (id int)`))).toBe('42501');
    expect(await sqlState(() => backup.query(`CREATE TABLE public.zz_backup_probe (id int)`))).toBe('42501');
  });

  it('n’exécute aucune fonction SECURITY DEFINER des schémas applicatifs (pas d’écriture détournée)', async () => {
    const { rows } = await backup.query<{ fn: string }>(
      `SELECT p.oid::regprocedure::text AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = ANY($1) AND p.prosecdef AND has_function_privilege(p.oid, 'EXECUTE')`,
      [SCHEMAS],
    );
    expect(rows.map((r) => r.fn)).toEqual([]);
  });

  it('reçoit SELECT sur une table future créée par ghmt_migrator (privilèges par défaut)', async () => {
    await migrator.query('BEGIN');
    try {
      await migrator.query('CREATE TABLE tenant.zz_backup_default_probe (id int)');
      await migrator.query('CREATE SEQUENCE platform.zz_backup_default_seq');
      const { rows } = await migrator.query<{ sel: boolean; ins: boolean; seq: boolean; nextval: boolean }>(
        `SELECT has_table_privilege('ghmt_backup', 'tenant.zz_backup_default_probe', 'SELECT') AS sel,
                has_table_privilege('ghmt_backup', 'tenant.zz_backup_default_probe', 'INSERT') AS ins,
                has_sequence_privilege('ghmt_backup', 'platform.zz_backup_default_seq', 'SELECT') AS seq,
                has_sequence_privilege('ghmt_backup', 'platform.zz_backup_default_seq', 'USAGE') AS nextval`,
      );
      expect(rows[0]).toEqual({ sel: true, ins: false, seq: true, nextval: false });
    } finally {
      await migrator.query('ROLLBACK');
    }
  });

  it('est idempotente : rejouée par ghmt_migrator sur une base où le rôle existe déjà', async () => {
    await migrator.query('BEGIN');
    try {
      await expect(migrator.query(MIGRATION_SQL)).resolves.toBeDefined();
    } finally {
      await migrator.query('ROLLBACK');
    }
  });
});
