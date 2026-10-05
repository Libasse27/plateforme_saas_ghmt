// Création d'un utilisateur du realm plateforme (premier Super Administrateur) — docs/09 §A1.
// Jamais d'endpoint public : ce script CLI est la seule voie de création.
//
// Usage :
//   node scripts/create-platform-admin.mts --email admin@ghmt.example --name "Nom Prénom" [--role super_admin|support|billing] [--generate]
//
// Mot de passe : saisi (invite masquée), fourni par la variable PLATFORM_ADMIN_PASSWORD, ou généré (--generate).
// Connexion : rôle `ghmt_platform` (PLATFORM_DATABASE_URL) — le script n'a pas besoin du rôle propriétaire.
// Le second facteur est enrôlé PAR LE SCRIPT (revue sécurité M2) : un compte plateforme n'existe jamais sans TOTP, et la
// connexion web est refusée tant qu'il n'est pas activé. L'URI otpauth, les codes de secours et le mot de passe généré ne
// sont affichés que sur un TERMINAL (stdout redirigé ⇒ refus avant toute création) : ils ne doivent jamais finir dans un journal.
// Variable requise : DATA_ENCRYPTION_KEY (même clé que l'API : le secret TOTP est chiffré AES-256-GCM, portée « platform »).
import 'dotenv/config';
import { createCipheriv, createHash, randomBytes, randomInt } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import * as argon2 from 'argon2';
import { generateSecret, generateURI } from 'otplib';
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

// ───────── Enrôlement TOTP (mêmes formats que FieldCrypto, backup-codes et TotpService de l'API) ─────────
const TOTP_ISSUER = 'GHMT';
/** Portée AAD du chiffrement des secrets TOTP plateforme (PLATFORM_CRYPTO_SCOPE de l'API). */
const PLATFORM_CRYPTO_SCOPE = 'platform';
const CRYPTO_FORMAT_VERSION = 1;
const CRYPTO_IV_BYTES = 12;
const DATA_KEY_BYTES = 32;
const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_LENGTH = 10;
const BACKUP_CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ23456789';

export interface Enrollment {
  readonly totpSecret: string;
  readonly otpauthUrl: string;
  readonly backupCodes: readonly string[];
}

/** Clé AES-256 de l'API (base64, 32 octets) : sans elle le secret TOTP ne pourrait pas être relu par l'API. */
export function loadDataKey(raw: string | undefined): Buffer {
  const key = Buffer.from(raw ?? '', 'base64');
  if (key.length !== DATA_KEY_BYTES) throw new CliError('DATA_ENCRYPTION_KEY absent ou invalide (32 octets en base64 attendus, identique à celle de l\'API).');
  return key;
}

/** Format identique à `FieldCrypto.encrypt` : [version 1 o][IV 12 o][tag 16 o][chiffré], AAD = portée « platform ». */
export function encryptTotpSecret(dataKey: Buffer, plaintext: string): Buffer {
  const iv = randomBytes(CRYPTO_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
  cipher.setAAD(Buffer.from(PLATFORM_CRYPTO_SCOPE, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([CRYPTO_FORMAT_VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

/** Même empreinte que `hashBackupCode` de l'API : seule cette valeur est stockée. */
export function hashBackupCode(userId: string, code: string): string {
  return createHash('sha256').update(`${userId}:${code}`).digest('hex');
}

function generateBackupCodes(): string[] {
  const codes = new Set<string>();
  while (codes.size < BACKUP_CODE_COUNT) {
    codes.add(Array.from({ length: BACKUP_CODE_LENGTH }, () => BACKUP_CODE_ALPHABET[randomInt(BACKUP_CODE_ALPHABET.length)]).join(''));
  }
  return [...codes];
}

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

/**
 * Insère l'utilisateur AVEC son second facteur activé (secret TOTP chiffré, codes de secours hachés) et sa trace d'audit,
 * dans une transaction ; refuse un e-mail déjà utilisé. Les secrets en clair ne sont renvoyés qu'à l'appelant.
 */
export async function createPlatformAdmin(
  client: pg.Client,
  input: CreateAdminParams,
  options: { readonly dataKey?: Buffer } = {},
): Promise<{ id: string; enrollment: Enrollment }> {
  const params = validateParams(input);
  const dataKey = options.dataKey ?? loadDataKey(process.env['DATA_ENCRYPTION_KEY']);
  const passwordHash = await argon2.hash(params.password, ARGON2_OPTIONS);
  const totpSecret = generateSecret();
  await client.query('BEGIN');
  try {
    const existing = await client.query('SELECT 1 FROM platform.platform_users WHERE email = $1', [params.email]);
    if (existing.rowCount) throw new CliError('Un utilisateur plateforme existe déjà avec cette adresse e-mail.');
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO platform.platform_users (id, email, password_hash, full_name, role, mfa_secret_enc, mfa_activated_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4::platform.platform_role, $5, now(), now()) RETURNING id::text AS id`,
      [params.email, passwordHash, params.fullName, params.role, encryptTotpSecret(dataKey, totpSecret)],
    );
    const id = rows[0]!.id;
    const backupCodes = generateBackupCodes();
    await client.query('UPDATE platform.platform_users SET mfa_backup_code_hashes = $2::text[] WHERE id = $1::uuid', [
      id,
      backupCodes.map((code) => hashBackupCode(id, code)),
    ]);
    await client.query(
      `INSERT INTO platform.audit_logs (id, actor_type, action, resource_type, resource_id, changes)
       VALUES (gen_random_uuid(), 'system', 'platform.user_created', 'platform_user', $1, $2::jsonb)`,
      [id, JSON.stringify({ role: params.role, via: 'cli', mfa: 'enrolled' })],
    );
    await client.query('COMMIT');
    return { id, enrollment: { totpSecret, otpauthUrl: generateURI({ issuer: TOTP_ISSUER, label: params.email, secret: totpSecret }), backupCodes } };
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

async function resolvePassword(generate: boolean, io: CliIo): Promise<{ password: string; generated: boolean }> {
  if (generate) return { password: generatePassword(), generated: true };
  const fromEnv = io.env['PLATFORM_ADMIN_PASSWORD'];
  if (fromEnv) return { password: fromEnv, generated: false };
  if (!io.stdin.isTTY) throw new CliError('Aucune saisie possible : utilisez --generate ou la variable PLATFORM_ADMIN_PASSWORD.');
  const first = await promptHidden('Mot de passe : ');
  const second = await promptHidden('Confirmation : ');
  if (first !== second) throw new CliError('Les deux saisies du mot de passe diffèrent.');
  return { password: first, generated: false };
}

/** Entrées/sorties injectables : permet de tester le comportement « terminal » sans pseudo-terminal. */
export interface CliIo {
  readonly stdout: { write(text: string): unknown; readonly isTTY?: boolean | undefined };
  readonly stdin: { readonly isTTY?: boolean | undefined };
  readonly env: NodeJS.ProcessEnv;
}

/** Les secrets (URI TOTP, codes de secours, mot de passe généré) ne s'affichent que sur un terminal, jamais dans un fichier ou un pipe. */
export function assertSecretsCanBeShown(stdout: CliIo['stdout']): void {
  if (stdout.isTTY !== true) {
    throw new CliError(
      'Sortie standard redirigée : l’URI TOTP, les codes de secours et le mot de passe généré ne s’affichent que dans un terminal. Relancez le script sans redirection.',
    );
  }
}

export function formatEnrollment(enrollment: Enrollment): string {
  return [
    'Second facteur (TOTP) enrôlé. À scanner MAINTENANT dans l’application d’authentification :',
    enrollment.otpauthUrl,
    'Codes de secours (usage unique, affichés une seule fois — à conserver dans un coffre) :',
    ...enrollment.backupCodes.map((code) => `  ${code}`),
    '',
  ].join('\n');
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<void> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
      role: { type: 'string', default: 'super_admin' },
      generate: { type: 'boolean', default: false },
    },
  });
  if (!values.email || !values.name) throw new CliError('Usage : --email <adresse> --name "<nom complet>" [--role super_admin|support|billing] [--generate]');
  const url = io.env['PLATFORM_DATABASE_URL'];
  if (!url) throw new CliError('PLATFORM_DATABASE_URL non défini.');
  // Refus AVANT toute création : un compte dont les secrets n'ont pas pu être montrés serait inutilisable.
  assertSecretsCanBeShown(io.stdout);
  const dataKey = loadDataKey(io.env['DATA_ENCRYPTION_KEY']);

  const { password, generated } = await resolvePassword(values.generate === true, io);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { id, enrollment } = await createPlatformAdmin(client, { email: values.email, fullName: values.name, role: values.role as PlatformRole, password }, { dataKey });
    io.stdout.write(`Utilisateur plateforme créé : ${id} (${values.role}).\n`);
    if (generated) io.stdout.write(`Mot de passe généré (affiché une seule fois, à changer et à conserver dans un coffre) : ${password}\n`);
    io.stdout.write(formatEnrollment(enrollment));
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  await runCli(process.argv.slice(2), { stdout: process.stdout, stdin: process.stdin, env: process.env });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof CliError ? error.message : error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
