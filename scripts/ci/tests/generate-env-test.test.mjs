// Génération du `.env.test` de la CI (docs/13 D1) : secrets aléatoires, base et base Redis paramétrables, rien d'affiché.
// Lancement : node --test 'scripts/ci/tests/*.test.mjs'
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { buildEnvTest, SECRET_KEYS } from '../generate-env-test.mjs';

const racine = resolve(import.meta.dirname, '../../..');
const script = resolve(racine, 'scripts/ci/generate-env-test.mjs');
const dossierTemporaire = () => mkdtempSync(join(tmpdir(), 'ghmt-ci-env-'));

describe('buildEnvTest', () => {
  it('cible la base et la base Redis demandées, avec les trois rôles PostgreSQL', () => {
    const env = parseEnv(buildEnvTest({ database: 'ghmt_test', redisDb: 14 }));
    assert.equal(env.NODE_ENV, 'test');
    assert.match(env.DATABASE_URL, /^postgresql:\/\/ghmt_app:[^@]+@localhost:5432\/ghmt_test$/);
    assert.match(env.PLATFORM_DATABASE_URL, /^postgresql:\/\/ghmt_platform:[^@]+@localhost:5432\/ghmt_test$/);
    assert.match(env.MIGRATION_DATABASE_URL, /^postgresql:\/\/ghmt_migrator:[^@]+@localhost:5432\/ghmt_test$/);
    assert.equal(env.REDIS_URL, 'redis://localhost:6379/14');
  });

  it('conserve les réglages imposés aux tests (aucune tâche de fond, limiteur en mémoire, journaux muets)', () => {
    const env = parseEnv(buildEnvTest({ database: 'ghmt_test', redisDb: 0 }));
    assert.equal(env.NOTIFICATIONS_WORKER_ENABLED, 'false');
    assert.equal(env.SECURITY_JOBS_ENABLED, 'false');
    assert.equal(env.RATE_LIMIT_STORE, 'memory');
    assert.equal(env.PAYMENTS_SANDBOX_ENABLED, 'true');
    assert.equal(env.LOG_LEVEL, 'silent');
  });

  it('génère des secrets aléatoires de la bonne taille, distincts entre eux et à chaque génération', () => {
    const premier = parseEnv(buildEnvTest({ database: 'ghmt_test', redisDb: 14 }));
    const second = parseEnv(buildEnvTest({ database: 'ghmt_test', redisDb: 14 }));
    for (const cle of SECRET_KEYS) {
      assert.notEqual(premier[cle], second[cle], `${cle} doit changer à chaque génération`);
    }
    assert.equal(Buffer.from(premier.DATA_ENCRYPTION_KEY, 'base64').length, 32);
    assert.equal(Buffer.from(premier.BLIND_INDEX_KEY, 'base64').length, 32);
    assert.ok(premier.JWT_ACCESS_SECRET.length >= 32);
    assert.ok(premier.JWT_PLATFORM_SECRET.length >= 32);
    assert.notEqual(premier.JWT_ACCESS_SECRET, premier.JWT_PLATFORM_SECRET);
  });

  it('refuse un nom de base ou une base Redis invalides', () => {
    assert.throws(() => buildEnvTest({ database: 'ghmt;drop', redisDb: 14 }), /nom de base invalide/);
    assert.throws(() => buildEnvTest({ database: 'ghmt_test', redisDb: 16 }), /base Redis invalide/);
    assert.throws(() => buildEnvTest({ database: 'ghmt_test', redisDb: -1 }), /base Redis invalide/);
  });

  it('a les mêmes variables que le .env.test local de référence, s\'il existe (détection de dérive)', (t) => {
    const reference = resolve(racine, 'apps/api/.env.test');
    if (!existsSync(reference)) return t.skip('pas de apps/api/.env.test local (cas de la CI)');
    const attendues = Object.keys(parseEnv(readFileSync(reference, 'utf8'))).sort();
    const generees = Object.keys(parseEnv(buildEnvTest({ database: 'ghmt_test', redisDb: 14 }))).sort();
    assert.deepEqual(generees, attendues);
  });
});

describe('generate-env-test.mjs (ligne de commande)', () => {
  it('écrit le fichier en 0600 sans jamais afficher de secret', () => {
    const sortie = join(dossierTemporaire(), '.env.test');
    const affichage = execFileSync(process.execPath, [script, '--output', sortie, '--database', 'ghmt_test_ci', '--redis-db', '14'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const env = parseEnv(readFileSync(sortie, 'utf8'));
    assert.equal(statSync(sortie).mode & 0o777, 0o600);
    assert.match(env.DATABASE_URL, /\/ghmt_test_ci$/);
    for (const cle of SECRET_KEYS) assert.ok(!affichage.includes(env[cle]), `${cle} ne doit pas être affiché`);
    assert.ok(!affichage.includes('postgresql://'), 'aucune chaîne de connexion affichée');
  });

  it('refuse d\'écraser un fichier existant sans --force', () => {
    const sortie = join(dossierTemporaire(), '.env.test');
    writeFileSync(sortie, 'EXISTANT=1\n');
    const resultat = spawnSync(process.execPath, [script, '--output', sortie], { encoding: 'utf8' });
    assert.notEqual(resultat.status, 0);
    assert.match(resultat.stderr, /existe déjà/);
    assert.equal(readFileSync(sortie, 'utf8'), 'EXISTANT=1\n');
  });

  it('écrase avec --force', () => {
    const sortie = join(dossierTemporaire(), '.env.test');
    writeFileSync(sortie, 'EXISTANT=1\n');
    execFileSync(process.execPath, [script, '--output', sortie, '--force'], { stdio: 'ignore' });
    assert.equal(parseEnv(readFileSync(sortie, 'utf8')).NODE_ENV, 'test');
  });

  it('refuse une option inconnue', () => {
    const resultat = spawnSync(process.execPath, [script, '--inconnue'], { encoding: 'utf8' });
    assert.notEqual(resultat.status, 0);
  });
});
