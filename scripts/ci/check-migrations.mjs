#!/usr/bin/env node
// Contrôle des migrations (docs/13 §11.1 point 2), exécuté par la CI après les tests :
//   1. `prisma migrate deploy` sur la base de test ;
//   2. `prisma migrate diff --from-migrations --to-schema` (base fantôme `<base>_shadow`) : aucun objet du schéma Prisma
//      ne doit manquer aux migrations. Seuls sont tolérés les objets que le projet déclare en SQL seulement (docs/07 §16) :
//      clés étrangères entre fichiers de schéma, index spécifiques (partiels, GIN, trigrammes) et EXCEPTIONS ci-dessous ;
//   3. chaque table `tenant.*` a la RLS activée ET forcée (`pg_class.relrowsecurity` et `relforcerowsecurity`).
// Aucune chaîne de connexion n'est affichée (dépôt public).
//   node scripts/ci/check-migrations.mjs [--env-file apps/api/.env.test] [--schema apps/api/prisma/schema] [--rls-only]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';

const racine = resolve(import.meta.dirname, '../..');
const api = resolve(racine, 'apps/api');
const configFantome = resolve(import.meta.dirname, 'prisma-shadow.config.ts');

/**
 * Exceptions documentées (table.colonne) : écarts structurels connus, sans migration manquante.
 * - `appointments.time_range` : colonne générée en SQL pour la contrainte EXCLUDE anti-chevauchement (core.prisma) ;
 * - défauts `time` : Prisma compare `'21:00:00'::time` à la forme normalisée par PostgreSQL et voit toujours un écart.
 * Toute nouvelle entrée exige une justification ici.
 */
const COLONNES_SQL_SEULEMENT = new Set(['tenant.appointments.time_range']);
const DEFAUTS_TIME = new Set([
  'tenant.notification_settings.quiet_hours_start',
  'tenant.notification_settings.quiet_hours_end',
  'tenant.notification_settings.reminder_d1_local_time',
]);

const ALTER_TABLE = /^ALTER TABLE "([^"]+)"\."([^"]+)"\s+([\s\S]+)$/;
const DROP_INDEX = /^DROP INDEX "[^"]+"\."[^"]+"$/;
const NOM_DE_BASE = /^[a-z_][a-z0-9_]{0,55}$/;

/** Clause d'un ALTER TABLE tolérée : clé étrangère SQL, ou exception documentée de la table. */
function clauseToleree(table, clause) {
  if (/^DROP CONSTRAINT "[^"]+"$/.test(clause)) return true;
  const colonne = /^DROP COLUMN "([^"]+)"$/.exec(clause);
  if (colonne) return COLONNES_SQL_SEULEMENT.has(`${table}.${colonne[1]}`);
  const defaut = /^ALTER COLUMN "([^"]+)" SET DEFAULT '[0-9:]+'::time$/.exec(clause);
  if (defaut) return DEFAUTS_TIME.has(`${table}.${defaut[1]}`);
  return false;
}

/** Sépare le script SQL de `migrate diff --script` en instructions, sans commentaires. */
function instructions(sql) {
  const sansCommentaires = sql
    .split('\n')
    .filter((ligne) => !ligne.trimStart().startsWith('--'))
    .join('\n');
  return sansCommentaires
    .split(/;\s*(?:\n|$)/)
    .map((instruction) => instruction.trim())
    .filter(Boolean);
}

/** Classe chaque instruction (ou clause d'ALTER TABLE) de l'écart en `tolerated` ou `violations`. */
export function classifyDiff(sql) {
  const tolerated = [];
  const violations = [];
  for (const instruction of instructions(sql)) {
    if (DROP_INDEX.test(instruction)) {
      tolerated.push(instruction);
      continue;
    }
    const alter = ALTER_TABLE.exec(instruction);
    if (!alter) {
      violations.push(instruction);
      continue;
    }
    const table = `${alter[1]}.${alter[2]}`;
    for (const clause of alter[3].split(/,\s*\n/).map((c) => c.trim())) {
      (clauseToleree(table, clause) ? tolerated : violations).push(`ALTER TABLE "${alter[1]}"."${alter[2]}" ${clause}`);
    }
  }
  return { tolerated, violations };
}

/** Tables (ordinaires ou partitionnées) du schéma `tenant` dont la RLS n'est pas activée ET forcée. */
export async function findTablesWithoutForcedRls(client) {
  const { rows } = await client.query(`
    SELECT n.nspname || '.' || c.relname AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'tenant'
       AND c.relkind IN ('r', 'p')
       AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
     ORDER BY 1`);
  return rows;
}

/** Nombre de tables du schéma `tenant` : un contrôle sur zéro table ne prouverait rien. */
async function compterTablesTenant(client) {
  const { rows } = await client.query(`
    SELECT count(*)::int AS total FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'tenant' AND c.relkind IN ('r', 'p')`);
  return rows[0].total;
}

const masquer = (texte) => texte.replace(/postgres(?:ql)?:\/\/\S+/g, 'postgresql://***');

/** Prisma de l'API, avec l'environnement donné ; la sortie d'erreur est masquée avant d'être relayée. */
function prisma(args, env) {
  try {
    return execFileSync(process.execPath, [resolve(api, 'node_modules/prisma/build/index.js'), ...args], {
      cwd: api,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = masquer(`${error.stdout ?? ''}${error.stderr ?? ''}`).trim();
    throw new Error(`prisma ${args[0]} ${args[1] ?? ''} a échoué.\n${detail}`);
  }
}

/** Écart migrations → schéma Prisma, calculé sur une base fantôme créée puis supprimée par le rôle propriétaire. */
async function ecartDuSchema(pg, urlMigration, schema) {
  const url = new URL(urlMigration);
  const base = url.pathname.slice(1);
  const fantome = `${base}_shadow`;
  if (!NOM_DE_BASE.test(base)) throw new Error('nom de base de test invalide dans MIGRATION_DATABASE_URL.');
  url.pathname = `/${fantome}`;
  const admin = new pg.Client({ connectionString: urlMigration });
  await admin.connect();
  const dossier = mkdtempSync(join(tmpdir(), 'ghmt-ci-diff-'));
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${fantome}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${fantome}"`);
    const sortie = join(dossier, 'diff.sql');
    prisma(
      ['migrate', 'diff', '--config', configFantome, '--from-migrations', 'prisma/migrations', '--to-schema', schema, '--script', '--output', sortie],
      { MIGRATION_DATABASE_URL: urlMigration, SHADOW_DATABASE_URL: url.toString() },
    );
    return readFileSync(sortie, 'utf8');
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS "${fantome}" WITH (FORCE)`).catch(() => undefined);
    await admin.end();
    rmSync(dossier, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      'env-file': { type: 'string', default: resolve(api, '.env.test') },
      schema: { type: 'string', default: resolve(api, 'prisma/schema') },
      'rls-only': { type: 'boolean', default: false },
    },
    strict: true,
  });
  const urlMigration = parseEnv(readFileSync(resolve(values['env-file']), 'utf8')).MIGRATION_DATABASE_URL;
  if (!urlMigration) throw new Error(`MIGRATION_DATABASE_URL absent de ${values['env-file']}.`);
  const pg = createRequire(resolve(api, 'package.json'))('pg');
  const echecs = [];

  prisma(['migrate', 'deploy'], { MIGRATION_DATABASE_URL: urlMigration });

  if (!values['rls-only']) {
    const { tolerated, violations } = classifyDiff(await ecartDuSchema(pg, urlMigration, resolve(values.schema)));
    process.stdout.write(`Écart schéma/migrations : ${tolerated.length} écart(s) toléré(s) (objets SQL seulement).\n`);
    for (const violation of violations) echecs.push(`objet du schéma Prisma absent des migrations : ${violation}`);
  }

  const client = new pg.Client({ connectionString: urlMigration });
  await client.connect();
  try {
    const total = await compterTablesTenant(client);
    if (total === 0) echecs.push('aucune table dans le schéma tenant : migrations non appliquées ?');
    for (const { table, enabled, forced } of await findTablesWithoutForcedRls(client)) {
      echecs.push(`RLS ${enabled ? 'non forcée' : 'désactivée'} sur ${table} (ENABLE et FORCE ROW LEVEL SECURITY requis)`);
    }
    process.stdout.write(`RLS : ${total} table(s) tenant contrôlée(s).\n`);
  } finally {
    await client.end();
  }

  if (echecs.length > 0) {
    for (const echec of echecs) process.stderr.write(`ERREUR : ${echec}\n`);
    process.exit(1);
  }
  process.stdout.write('OK : migrations cohérentes avec le schéma Prisma, RLS activée et forcée sur toutes les tables tenant.\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`ERREUR : ${masquer(error instanceof Error ? error.message : String(error))}\n`);
    process.exit(1);
  });
}
