// Création d'un utilisateur du realm plateforme (premier Super Administrateur) — docs/09 §A1.
// Jamais d'endpoint public : ce script CLI est la seule voie de création.
//
// Usage :
//   node scripts/create-platform-admin.mts --email admin@ghmt.example --name "Nom Prénom" [--role super_admin|support|billing] [--generate]
//
// Mot de passe : saisi (invite masquée), fourni par la variable PLATFORM_ADMIN_PASSWORD, ou généré (--generate) et affiché UNE fois.
// Connexion : rôle `ghmt_platform` (PLATFORM_DATABASE_URL) — le script n'a pas besoin du rôle propriétaire.
// L'enrôlement TOTP est imposé à la première connexion.
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import * as argon2 from 'argon2';
import pg from 'pg';

export const PLATFORM_ROLES = ['super_admin', 'support', 'billing'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

/** Mêmes bornes que `PRIVILEGED_PASSWORD_MIN_LENGTH` / `PASSWORD_MAX_LENGTH` (packages/shared). */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;
const GENERATED_PASSWORD_BYTES = 24;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Mêmes paramètres Argon2id que `PasswordService` (docs/04 §1.3). */
const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 1 } as const;

export class CliError extends Error {}

export interface CreateAdminParams {
  readonly email: string;
  readonly fullName: string;
  readonly role: PlatformRole;
  readonly password: string;
}

export function generatePassword(): string {
  return randomBytes(GENERATED_PASSWORD_BYTES).toString('base64url');
}

/** Valide les entrées ; lève `CliError` avec un message en français. */
export function validateParams(params: CreateAdminParams): CreateAdminParams {
  const email = params.email.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email) || email.length > 254) throw new CliError('Adresse e-mail invalide.');
  const fullName = params.fullName.trim();
  if (fullName.length < 2 || fullName.length > 120) throw new CliError('Le nom complet doit contenir entre 2 et 120 caractères.');
  if (!(PLATFORM_ROLES as readonly string[]).includes(params.role)) throw new CliError(`Rôle invalide (attendu : ${PLATFORM_ROLES.join(', ')}).`);
  if (params.password.length < MIN_PASSWORD_LENGTH || params.password.length > MAX_PASSWORD_LENGTH) {
    throw new CliError(`Le mot de passe doit contenir entre ${MIN_PASSWORD_LENGTH} et ${MAX_PASSWORD_LENGTH} caractères.`);
  }
  return { ...params, email, fullName };
}

/** Insère l'utilisateur et sa trace d'audit dans une transaction ; refuse un e-mail déjà utilisé. */
export async function createPlatformAdmin(client: pg.Client, input: CreateAdminParams): Promise<{ id: string }> {
  const params = validateParams(input);
  const passwordHash = await argon2.hash(params.password, ARGON2_OPTIONS);
  await client.query('BEGIN');
  try {
    const existing = await client.query('SELECT 1 FROM platform.platform_users WHERE email = $1', [params.email]);
    if (existing.rowCount) throw new CliError('Un utilisateur plateforme existe déjà avec cette adresse e-mail.');
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO platform.platform_users (id, email, password_hash, full_name, role, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4::platform.platform_role, now()) RETURNING id::text AS id`,
      [params.email, passwordHash, params.fullName, params.role],
    );
    const id = rows[0]!.id;
    await client.query(
      `INSERT INTO platform.audit_logs (id, actor_type, action, resource_type, resource_id, changes)
       VALUES (gen_random_uuid(), 'system', 'platform.user_created', 'platform_user', $1, $2::jsonb)`,
      [id, JSON.stringify({ role: params.role, via: 'cli' })],
    );
    await client.query('COMMIT');
    return { id };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** Invite masquée : la saisie n'est jamais répétée à l'écran. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    const writable = rl as unknown as { _writeToOutput: (text: string) => void };
    let muted = false;
    writable._writeToOutput = (text: string) => {
      if (!muted) process.stderr.write(text);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stderr.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

async function resolvePassword(generate: boolean): Promise<{ password: string; generated: boolean }> {
  if (generate) return { password: generatePassword(), generated: true };
  const fromEnv = process.env['PLATFORM_ADMIN_PASSWORD'];
  if (fromEnv) return { password: fromEnv, generated: false };
  if (!process.stdin.isTTY) throw new CliError('Aucune saisie possible : utilisez --generate ou la variable PLATFORM_ADMIN_PASSWORD.');
  const first = await promptHidden('Mot de passe : ');
  const second = await promptHidden('Confirmation : ');
  if (first !== second) throw new CliError('Les deux saisies du mot de passe diffèrent.');
  return { password: first, generated: false };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
      role: { type: 'string', default: 'super_admin' },
      generate: { type: 'boolean', default: false },
    },
  });
  if (!values.email || !values.name) throw new CliError('Usage : --email <adresse> --name "<nom complet>" [--role super_admin|support|billing] [--generate]');
  const url = process.env['PLATFORM_DATABASE_URL'];
  if (!url) throw new CliError('PLATFORM_DATABASE_URL non défini.');

  const { password, generated } = await resolvePassword(values.generate === true);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { id } = await createPlatformAdmin(client, { email: values.email, fullName: values.name, role: values.role as PlatformRole, password });
    process.stdout.write(`Utilisateur plateforme créé : ${id} (${values.role}).\n`);
    if (generated) process.stdout.write(`Mot de passe généré (affiché une seule fois, à changer et à conserver dans un coffre) : ${password}\n`);
    process.stdout.write('Le second facteur (TOTP) sera à enrôler à la première connexion.\n');
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof CliError ? error.message : error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
