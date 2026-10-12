// Contrôle des migrations (docs/13 §11.1 point 2) : écart schéma Prisma / migrations, et RLS activée ET forcée sur tenant.*.
// Les tests d'intégration utilisent la base de apps/api/.env.test (ghmt_test_ci en local, ghmt_test en CI) ; ignorés sans elle.
// Lancement : node --test 'scripts/ci/tests/*.test.mjs'
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { classifyDiff, findTablesWithoutForcedRls } from '../check-migrations.mjs';

const racine = resolve(import.meta.dirname, '../../..');
const api = resolve(racine, 'apps/api');
const script = resolve(racine, 'scripts/ci/check-migrations.mjs');
const fichierEnv = resolve(api, '.env.test');
const sansBase = !existsSync(fichierEnv) && 'pas de apps/api/.env.test (générer avec scripts/ci/generate-env-test.mjs)';

describe('classifyDiff', () => {
  it('un écart vide ne contient aucune violation', () => {
    assert.deepEqual(classifyDiff(''), { tolerated: [], violations: [] });
    assert.deepEqual(classifyDiff('-- This is an empty migration.\n'), { tolerated: [], violations: [] });
  });

  it('tolère les clés étrangères et index déclarés en SQL seulement (non modélisés par Prisma)', () => {
    const sql = [
      '-- DropForeignKey',
      'ALTER TABLE "tenant"."payments" DROP CONSTRAINT "fk_payments_invoice";',
      '',
      '-- DropIndex',
      'DROP INDEX "tenant"."ix_patients_search_name";',
    ].join('\n');
    const { tolerated, violations } = classifyDiff(sql);
    assert.equal(tolerated.length, 2);
    assert.deepEqual(violations, []);
  });

  it('tolère les exceptions documentées (colonne générée, défaut `time`)', () => {
    const sql = [
      'ALTER TABLE "tenant"."appointments" DROP COLUMN "time_range";',
      `ALTER TABLE "tenant"."notification_settings" ALTER COLUMN "quiet_hours_start" SET DEFAULT '21:00:00'::time,`,
      `ALTER COLUMN "quiet_hours_end" SET DEFAULT '07:00:00'::time;`,
    ].join('\n');
    assert.deepEqual(classifyDiff(sql).violations, []);
  });

  it('signale une table, une colonne, un type ou un index déclarés dans le schéma sans migration', () => {
    const cas = [
      'CREATE TABLE "tenant"."files" ("id" UUID NOT NULL, CONSTRAINT "files_pkey" PRIMARY KEY ("id"));',
      'ALTER TABLE "tenant"."patients" ADD COLUMN "nickname" TEXT;',
      `CREATE TYPE "tenant"."file_status" AS ENUM ('pending', 'available');`,
      'CREATE INDEX "ix_x" ON "tenant"."patients"("tenant_id");',
      'ALTER TABLE "tenant"."patients" DROP COLUMN "first_name_enc";',
      `ALTER TABLE "tenant"."patients" ALTER COLUMN "status" SET DEFAULT 'active';`,
    ];
    for (const sql of cas) assert.equal(classifyDiff(sql).violations.length, 1, sql);
  });

  it("signale une clause interdite dans un ALTER TABLE à plusieurs clauses, même entourée de clauses tolérées", () => {
    const sql = [
      'ALTER TABLE "tenant"."notification_settings" DROP CONSTRAINT "fk_x",',
      'ALTER COLUMN "quiet_hours_end" SET DATA TYPE TIME(3);',
    ].join('\n');
    const { tolerated, violations } = classifyDiff(sql);
    assert.equal(tolerated.length, 1);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /SET DATA TYPE/);
  });
});

/** Client `pg` de l'API (aucune dépendance ajoutée à la racine), connecté avec le rôle propriétaire des migrations. */
async function connecter() {
  const { Client } = createRequire(resolve(api, 'package.json'))('pg');
  const client = new Client({ connectionString: parseEnv(readFileSync(fichierEnv, 'utf8')).MIGRATION_DATABASE_URL });
  await client.connect();
  return client;
}

describe('findTablesWithoutForcedRls (intégration)', { skip: sansBase }, () => {
  it('ne signale rien sur la base migrée', async () => {
    spawnSync(process.execPath, [script, '--rls-only'], { stdio: 'ignore' }); // applique les migrations si besoin
    const client = await connecter();
    try {
      assert.deepEqual(await findTablesWithoutForcedRls(client), []);
    } finally {
      await client.end();
    }
  });

  it('signale une table tenant sans RLS, puis avec RLS activée mais non forcée, et l\'accepte forcée', async () => {
    const client = await connecter();
    try {
      await client.query('BEGIN');
      await client.query('CREATE TABLE tenant.ci_sonde_rls (id int PRIMARY KEY)');
      assert.deepEqual(await findTablesWithoutForcedRls(client), [{ table: 'tenant.ci_sonde_rls', enabled: false, forced: false }]);
      await client.query('ALTER TABLE tenant.ci_sonde_rls ENABLE ROW LEVEL SECURITY');
      assert.deepEqual(await findTablesWithoutForcedRls(client), [{ table: 'tenant.ci_sonde_rls', enabled: true, forced: false }]);
      await client.query('ALTER TABLE tenant.ci_sonde_rls FORCE ROW LEVEL SECURITY');
      assert.deepEqual(await findTablesWithoutForcedRls(client), []);
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });
});

describe('check-migrations.mjs (ligne de commande, intégration)', { skip: sansBase }, () => {
  const lancer = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 240_000 });

  it('réussit sur le dépôt, sans afficher de chaîne de connexion', () => {
    const resultat = lancer();
    assert.equal(resultat.status, 0, resultat.stdout + resultat.stderr);
    assert.match(resultat.stdout, /OK/);
    assert.ok(!`${resultat.stdout}${resultat.stderr}`.includes('postgresql://'), 'aucune chaîne de connexion affichée');
  });

  it('échoue quand le schéma Prisma déclare un modèle sans migration', () => {
    const schema = join(mkdtempSync(join(tmpdir(), 'ghmt-ci-schema-')), 'schema');
    cpSync(resolve(api, 'prisma/schema'), schema, { recursive: true });
    appendFileSync(join(schema, 'core.prisma'), '\nmodel CiSondeSansMigration {\n  id Int @id\n\n  @@map("ci_sonde_sans_migration")\n  @@schema("tenant")\n}\n');
    const resultat = lancer('--schema', schema);
    assert.equal(resultat.status, 1, resultat.stdout + resultat.stderr);
    assert.match(resultat.stderr, /ci_sonde_sans_migration/);
  });
});
