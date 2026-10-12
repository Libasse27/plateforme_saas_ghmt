#!/usr/bin/env node
// Génère apps/api/.env.test pour la CI (docs/13 D1) : secrets aléatoires à chaque exécution, aucun secret de dépôt requis.
// Les mots de passe PostgreSQL sont ceux des rôles de DÉVELOPPEMENT créés par infra/postgres/init/01-roles.sql (pile jetable).
// Le dépôt est public : rien n'est affiché hormis le chemin écrit et le nombre de variables.
//   node scripts/ci/generate-env-test.mjs [--output apps/api/.env.test] [--database ghmt_test] [--redis-db 14] [--force]
// Les variables suivent apps/api/.env.test (fichier commun, phase 0) : toute variable ajoutée là doit l'être ici
// (le test de dérive de scripts/ci/tests/generate-env-test.test.mjs le signale en local).
import { randomBytes } from 'node:crypto';
import { closeSync, fchmodSync, openSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** Variables secrètes tirées au hasard (jamais écrites ailleurs que dans le fichier, jamais affichées). */
export const SECRET_KEYS = ['JWT_ACCESS_SECRET', 'JWT_PLATFORM_SECRET', 'DATA_ENCRYPTION_KEY', 'BLIND_INDEX_KEY'];

const NOM_DE_BASE = /^[a-z_][a-z0-9_]{0,62}$/;
const REDIS_DB_MAX = 15;
const OCTETS_JWT = 48;
const OCTETS_CLE = 32;

/** Rôles de la pile de développement (01-roles.sql) : identifiants publics d'une base jetable, pas des secrets. */
const ROLES = { app: 'ghmt_app:ghmt_app_dev', platform: 'ghmt_platform:ghmt_platform_dev', migrator: 'ghmt_migrator:ghmt_migrator_dev' };

const aleatoire = (octets) => randomBytes(octets).toString('base64');

/** Contenu du fichier `.env.test` ; lève une erreur si la base ou la base Redis sont invalides. */
export function buildEnvTest({ database, redisDb }) {
  if (!NOM_DE_BASE.test(database)) throw new Error(`nom de base invalide : ${database}`);
  if (!Number.isInteger(redisDb) || redisDb < 0 || redisDb > REDIS_DB_MAX) throw new Error(`base Redis invalide : ${redisDb}`);
  const url = (role) => `postgresql://${ROLES[role]}@localhost:5432/${database}`;
  const lignes = [
    '# Généré par scripts/ci/generate-env-test.mjs (CI) : secrets aléatoires, pile jetable de infra/docker-compose.yml.',
    'NODE_ENV=test',
    'PORT=3000',
    `DATABASE_URL=${url('app')}`,
    `PLATFORM_DATABASE_URL=${url('platform')}`,
    `MIGRATION_DATABASE_URL=${url('migrator')}`,
    `JWT_ACCESS_SECRET=${aleatoire(OCTETS_JWT)}`,
    `JWT_PLATFORM_SECRET=${aleatoire(OCTETS_JWT)}`,
    'JWT_ISSUER=https://api.ghmt.local',
    'JWT_AUDIENCE=ghmt-api',
    `DATA_ENCRYPTION_KEY=${aleatoire(OCTETS_CLE)}`,
    `BLIND_INDEX_KEY=${aleatoire(OCTETS_CLE)}`,
    'CORS_ORIGINS=http://localhost:3001',
    'LOG_LEVEL=silent',
    'TRUSTED_PROXIES=loopback',
    'WEB_URL=http://localhost:3001',
    'SMTP_HOST=localhost',
    'SMTP_PORT=1025',
    'MAIL_FROM="GHMT <no-reply@ghmt.local>"',
    'PAYMENTS_SANDBOX_ENABLED=true',
    'CINETPAY_API_KEY=',
    'CINETPAY_SITE_ID=',
    'CINETPAY_SECRET_KEY=',
    'CINETPAY_BASE_URL=https://api-checkout.cinetpay.com/v2',
    'CINETPAY_NOTIFY_URL=',
    'CINETPAY_RETURN_URL=',
    'NOTIFICATIONS_WORKER_ENABLED=false',
    'SMS_PROVIDER=sandbox',
    'SMS_SANDBOX_WEBHOOKS_ENABLED=true',
    `REDIS_URL=redis://localhost:6379/${redisDb}`,
    'RATE_LIMIT_STORE=memory',
    'SECURITY_JOBS_ENABLED=false',
  ];
  return `${lignes.join('\n')}\n`;
}

function main() {
  const { values } = parseArgs({
    options: {
      output: { type: 'string', default: 'apps/api/.env.test' },
      database: { type: 'string', default: 'ghmt_test' },
      'redis-db': { type: 'string', default: '14' },
      force: { type: 'boolean', default: false },
    },
    strict: true,
  });
  const sortie = resolve(values.output);
  const contenu = buildEnvTest({ database: values.database, redisDb: Number(values['redis-db']) });
  // Sans --force : création exclusive atomique (`wx`), aucun intervalle entre le contrôle d'existence et l'écriture.
  // Droits fixés sur le descripteur ouvert (`mode` ne s'applique qu'à la création, cas --force), jamais par chemin.
  let fd;
  try {
    fd = openSync(sortie, values.force ? 'w' : 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`${sortie} existe déjà : relancer avec --force pour l'écraser.`);
    throw error;
  }
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, contenu);
  } finally {
    closeSync(fd);
  }
  const nombre = contenu.split('\n').filter((l) => /^[A-Z_]+=/.test(l)).length;
  process.stdout.write(`OK : ${sortie} généré (${nombre} variables, secrets aléatoires).\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`ERREUR : ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
