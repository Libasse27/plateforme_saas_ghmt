// Transfert de l'administrateur principal d'un établissement par script terminal — docs/11 §5.7 et §14.2 point 9.
// Cas d'usage : le principal est parti sans avoir transféré son titre (aucune voie dans l'application ; la console plateforme
// n'offre pas ce transfert au MVP). Réservé à l'exploitation : il se connecte avec le rôle propriétaire (MIGRATION_DATABASE_URL).
//
// Usage :
//   node scripts/transfer-tenant-owner.mts --tenant <code-établissement> --email <e-mail du nouveau principal> \
//        --operator "<nom de l'opérateur>" --reason "<motif, 10 à 500 caractères>" [--allow-without-totp] [--grant-admin]
//
// Règles :
// - le nouveau principal est un utilisateur actif portant le rôle SYSTÈME `tenant_admin` à portée établissement ;
// - il doit avoir un TOTP actif, sauf `--allow-without-totp` (option journalisée dans l'audit) ;
// - `--grant-admin` : quand l'établissement n'a plus AUCUN administrateur actif, le rôle `tenant_admin` lui est d'abord affecté
//   (audit `iam.assignment.created`) ; refusé s'il reste un administrateur actif ;
// - audit `iam.owner.transferred` (acteur `system`, `changes.via: 'cli'`, opérateur, motif, utilisateur OS et hôte) ;
// - alerte `security.owner_transferred` aux directeurs et au nouveau principal (e-mail et in-app, envoyée par le dispatcher).
// Refus si la sortie standard est redirigée (aucun résultat n'est destiné à un journal) — vérifié AVANT toute connexion.
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { GENESIS_HASH, chainHash } from '../src/common/audit/audit-chain.ts';
import { dedupKey } from '../src/modules/notifications/domain/dedup-key.ts';

export class CliError extends Error {}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const TENANT_ADMIN_ROLE = 'tenant_admin';
/** Copie du critère « directeur » de `src/common/authz/director-role.ts` (`DIRECTOR_ROLE`), qui fait foi. */
const DIRECTOR_TEMPLATE = 'director';
const OPERATOR_LENGTH = { min: 2, max: 120 } as const;
const REASON_LENGTH = { min: 10, max: 500 } as const;
const ALERT_TYPE = 'security.owner_transferred';
/** Canaux du type `security.owner_transferred` (NOTIFICATION_TYPES de @ghmt/shared, non importable ici sans compilation). */
const ALERT_CHANNELS = ['email', 'inapp'] as const;
const EMAIL_DEADLINE_MS = 24 * 60 * 60 * 1000;

export interface TransferParams {
  readonly slug: string;
  readonly email: string;
  readonly operator: string;
  readonly reason: string;
  readonly allowWithoutTotp: boolean;
  readonly grantAdmin: boolean;
}

/** Poste d'exploitation d'où le script est lancé (repris dans l'audit). */
export interface CliOrigin {
  readonly osUser: string;
  readonly host: string;
}

export interface TransferResult {
  readonly tenantId: string;
  readonly fromUserId: string | null;
  readonly toUserId: string;
  readonly grantedAdmin: boolean;
}

function boundedText(value: string | undefined, bounds: { readonly min: number; readonly max: number }, message: string): string {
  const text = value?.trim() ?? '';
  if (text.length < bounds.min || text.length > bounds.max) throw new CliError(message);
  return text;
}

export function parseCliArgs(argv: readonly string[]): TransferParams {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      tenant: { type: 'string' },
      email: { type: 'string' },
      operator: { type: 'string' },
      reason: { type: 'string' },
      'allow-without-totp': { type: 'boolean', default: false },
      'grant-admin': { type: 'boolean', default: false },
    },
    strict: true,
  });
  const slug = values.tenant?.trim().toLowerCase() ?? '';
  const email = values.email?.trim().toLowerCase() ?? '';
  if (!SLUG_PATTERN.test(slug)) throw new CliError('--tenant : code établissement invalide.');
  if (!EMAIL_PATTERN.test(email)) throw new CliError('--email : adresse e-mail invalide.');
  return {
    slug,
    email,
    operator: boundedText(values.operator, OPERATOR_LENGTH, `--operator : nom de l'opérateur obligatoire (${OPERATOR_LENGTH.min} à ${OPERATOR_LENGTH.max} caractères).`),
    reason: boundedText(values.reason, REASON_LENGTH, `--reason : motif obligatoire (${REASON_LENGTH.min} à ${REASON_LENGTH.max} caractères).`),
    allowWithoutTotp: values['allow-without-totp'] === true,
    grantAdmin: values['grant-admin'] === true,
  };
}

/** Refus si la sortie standard n'est pas un terminal : le résultat ne doit jamais finir dans un journal. */
export function assertTerminal(stdout: { readonly isTTY?: boolean | undefined }): void {
  if (stdout.isTTY !== true) throw new CliError('Sortie standard redirigée : exécutez ce script dans un terminal interactif.');
}

export function currentOrigin(): CliOrigin {
  let osUser = 'inconnu';
  try {
    osUser = userInfo().username;
  } catch {
    // Utilisateur sans entrée dans la base des comptes (conteneur) : on garde « inconnu ».
  }
  return { osUser, host: hostname() };
}

/** Transfert dans UNE transaction : contexte RLS posé tenant par tenant (FORCE RLS s'applique au propriétaire). */
export async function transferTenantOwner(client: pg.Client, params: TransferParams, origin: CliOrigin = currentOrigin()): Promise<TransferResult> {
  await client.query('BEGIN');
  try {
    const result = await transfer(client, params, origin);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

interface Candidate {
  readonly id: string;
  readonly fullName: string;
  readonly hasTotp: boolean;
  readonly isAdmin: boolean;
}

/** Affectation valide du rôle SYSTÈME `tenant_admin` à portée établissement (alias `u` : utilisateur). */
const ADMIN_ASSIGNMENT = `
  SELECT 1 FROM tenant.user_role_assignments a JOIN tenant.roles r ON r.tenant_id = a.tenant_id AND r.id = a.role_id
  WHERE a.tenant_id = u.tenant_id AND a.user_id = u.id AND a.scope_type = 'tenant' AND a.revoked_at IS NULL
    AND a.valid_from <= now() AND (a.valid_until IS NULL OR a.valid_until > now())
    AND r.code = '${TENANT_ADMIN_ROLE}' AND r.is_system AND r.deleted_at IS NULL`;

async function findCandidate(client: pg.Client, tenantId: string, email: string): Promise<Candidate | null> {
  const rows = await client.query<{ id: string; full_name: string; has_totp: boolean; is_admin: boolean }>(
    `SELECT u.id, u.full_name,
            EXISTS (SELECT 1 FROM tenant.mfa_factors f WHERE f.tenant_id = u.tenant_id AND f.user_id = u.id AND f.kind = 'totp' AND f.activated_at IS NOT NULL) AS has_totp,
            EXISTS (${ADMIN_ASSIGNMENT}) AS is_admin
     FROM tenant.users u WHERE u.tenant_id = $1 AND u.email = $2 AND u.status = 'active' AND u.deleted_at IS NULL`,
    [tenantId, email],
  );
  const row = rows.rows[0];
  return row ? { id: row.id, fullName: row.full_name, hasTotp: row.has_totp, isAdmin: row.is_admin } : null;
}

async function countActiveAdmins(client: pg.Client, tenantId: string): Promise<number> {
  const rows = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM tenant.users u WHERE u.tenant_id = $1 AND u.status = 'active' AND u.deleted_at IS NULL AND EXISTS (${ADMIN_ASSIGNMENT})`,
    [tenantId],
  );
  return Number(rows.rows[0]?.count ?? 0);
}

/** Contrôles du candidat ; renvoie vrai s'il faut lui affecter `tenant_admin` (`--grant-admin`). */
async function assertEligible(client: pg.Client, tenantId: string, candidate: Candidate | null, params: TransferParams): Promise<boolean> {
  if (!candidate) throw new CliError('Le nouvel administrateur principal doit être un utilisateur actif de l’établissement.');
  if (params.grantAdmin && (await countActiveAdmins(client, tenantId)) > 0) {
    throw new CliError('--grant-admin refusé : l’établissement a encore un administrateur actif.');
  }
  if (!params.grantAdmin && !candidate.isAdmin) {
    throw new CliError('Le nouvel administrateur principal doit être un administrateur actif (rôle système tenant_admin) de l’établissement.');
  }
  if (!candidate.hasTotp && !params.allowWithoutTotp) {
    throw new CliError('Le nouvel administrateur principal doit avoir activé le second facteur (TOTP), sauf --allow-without-totp.');
  }
  return params.grantAdmin;
}

async function transfer(client: pg.Client, params: TransferParams, origin: CliOrigin): Promise<TransferResult> {
  const tenant = await client.query<{ id: string }>('SELECT id FROM platform.tenants WHERE slug = $1 AND deleted_at IS NULL', [params.slug]);
  const tenantId = tenant.rows[0]?.id;
  if (!tenantId) throw new CliError('Établissement introuvable.');
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);

  // Verrou AVANT de lire le candidat et de compter les administrateurs : sérialisé avec un transfert, une désactivation ou
  // le retrait d'un rôle administrateur faits depuis l'application (même ligne verrouillée).
  const current = await client.query<{ owner_user_id: string | null }>('SELECT owner_user_id FROM tenant.security_settings WHERE tenant_id = $1 FOR UPDATE', [tenantId]);
  const fromUserId = current.rows[0]?.owner_user_id ?? null;
  const candidate = await findCandidate(client, tenantId, params.email);
  const grantedAdmin = await assertEligible(client, tenantId, candidate, params);
  const toUserId = candidate!.id;
  const trace = { via: 'cli', operator: params.operator, reason: params.reason, osUser: origin.osUser, host: origin.host };
  if (grantedAdmin) await grantAdmin(client, tenantId, toUserId, trace);

  await client.query(
    `INSERT INTO tenant.security_settings (tenant_id, owner_user_id) VALUES ($1, $2)
     ON CONFLICT (tenant_id) DO UPDATE SET owner_user_id = EXCLUDED.owner_user_id, updated_at = now()`,
    [tenantId, toUserId],
  );
  await appendAudit(client, tenantId, {
    action: 'iam.owner.transferred',
    resourceType: 'user',
    resourceId: toUserId,
    changes: { fromUserId, toUserId, ...trace, allowWithoutTotp: params.allowWithoutTotp },
  });
  await notifyOwnerTransferred(client, tenantId, candidate!, params.operator);
  return { tenantId, fromUserId, toUserId, grantedAdmin };
}

/** Affectation `tenant_admin` (rôle système) à portée établissement, auditée comme une affectation de l'application. */
async function grantAdmin(client: pg.Client, tenantId: string, userId: string, trace: Record<string, string>): Promise<void> {
  const role = await client.query<{ id: string }>('SELECT id FROM tenant.roles WHERE tenant_id = $1 AND code = $2 AND is_system AND deleted_at IS NULL', [
    tenantId,
    TENANT_ADMIN_ROLE,
  ]);
  const roleId = role.rows[0]?.id;
  if (!roleId) throw new CliError('Rôle système tenant_admin introuvable dans l’établissement.');
  const assignmentId = randomUUID();
  await client.query(`INSERT INTO tenant.user_role_assignments (id, tenant_id, user_id, role_id, scope_type) VALUES ($1, $2, $3, $4, 'tenant')`, [
    assignmentId,
    tenantId,
    userId,
    roleId,
  ]);
  await appendAudit(client, tenantId, {
    action: 'iam.assignment.created',
    resourceType: 'user_role_assignment',
    resourceId: assignmentId,
    changes: { userId, after: { roleId, roleCode: TENANT_ADMIN_ROLE, scopeType: 'tenant', scopeId: null, validUntil: null }, ...trace },
  });
}

interface AlertRecipient {
  readonly id: string;
  readonly locale: string;
}

/** Directeurs actifs (rôle système, portée établissement) et nouveau principal, sans doublon. */
async function alertRecipients(client: pg.Client, tenantId: string, ownerId: string): Promise<AlertRecipient[]> {
  const rows = await client.query<AlertRecipient>(
    `SELECT u.id, u.locale FROM tenant.users u
     WHERE u.tenant_id = $1 AND u.status = 'active' AND u.deleted_at IS NULL
       AND (u.id = $2 OR EXISTS (
         SELECT 1 FROM tenant.user_role_assignments a JOIN tenant.roles r ON r.tenant_id = a.tenant_id AND r.id = a.role_id
         WHERE a.tenant_id = u.tenant_id AND a.user_id = u.id AND a.scope_type = 'tenant' AND a.revoked_at IS NULL
           AND a.valid_from <= now() AND (a.valid_until IS NULL OR a.valid_until > now())
           AND r.is_system AND r.template_code = $3 AND r.deleted_at IS NULL))
     ORDER BY u.id`,
    [tenantId, ownerId, DIRECTOR_TEMPLATE],
  );
  return rows.rows;
}

/** Alerte `security.owner_transferred` en file d'envoi (même forme que `SecurityAlertService.establishmentAlert`). */
async function notifyOwnerTransferred(client: pg.Client, tenantId: string, owner: Candidate, operator: string): Promise<void> {
  const subjectId = randomUUID();
  const now = new Date();
  const context = { targetUserId: owner.id, targetName: owner.fullName, actorName: `Exploitation GHMT (${operator})` };
  for (const recipient of await alertRecipients(client, tenantId, owner.id)) {
    for (const channel of ALERT_CHANNELS) {
      const key = dedupKey({ tenantId, sourceKey: subjectId, typeCode: ALERT_TYPE, recipientType: 'user', recipientId: recipient.id, channel });
      const deadline = channel === 'email' ? new Date(now.getTime() + EMAIL_DEADLINE_MS) : null;
      await client.query(
        `INSERT INTO tenant.notifications (
           id, tenant_id, type_code, category, channel, recipient_type, recipient_id, subject_type, subject_id, dedup_key, locale, context,
           status, scheduled_at, next_attempt_at, deadline_at, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'administrative', $3, 'user', $4, 'security_event', $5, $6, $7, $8::jsonb, 'queued', $9, $9, $10, $9, $9)
         ON CONFLICT DO NOTHING`,
        [tenantId, ALERT_TYPE, channel, recipient.id, subjectId, key, recipient.locale === 'en' ? 'en' : 'fr', JSON.stringify(context), now, deadline],
      );
    }
  }
}

interface CliAuditEvent {
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly changes: Record<string, unknown>;
}

/** Maillon de la chaîne d'audit : même charge utile et même hachage que `AuditService` (src/common/audit/audit.service.ts). */
async function appendAudit(client: pg.Client, tenantId: string, event: CliAuditEvent): Promise<void> {
  const sequence = await client.query<{ seq: string }>("SELECT tenant.next_sequence('audit') AS seq");
  const seq = BigInt(sequence.rows[0]!.seq);
  let prevHash: Buffer = GENESIS_HASH;
  if (seq > 1n) {
    const previous = await client.query<{ hash: Buffer }>('SELECT hash FROM tenant.audit_logs WHERE tenant_id = $1 AND chain_seq = $2', [tenantId, (seq - 1n).toString()]);
    if (!previous.rows[0]) throw new CliError('Rupture de la chaîne d’audit : maillon précédent introuvable.');
    prevHash = previous.rows[0].hash;
  }
  const occurredAt = new Date();
  const hash = chainHash(prevHash, {
    tenantId,
    chainSeq: seq.toString(),
    occurredAt: occurredAt.toISOString(),
    actorType: 'system',
    actorUserId: null,
    sessionId: null,
    ip: null,
    action: event.action,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    patientId: null,
    outcome: 'success',
    changes: event.changes,
    requestId: null,
  });
  await client.query(
    `INSERT INTO tenant.audit_logs (id, tenant_id, occurred_at, chain_seq, actor_type, action, resource_type, resource_id, outcome, changes, prev_hash, hash)
     VALUES (gen_random_uuid(), $1, $2, $3, 'system', $4, $5, $6, 'success', $7::jsonb, $8, $9)`,
    [tenantId, occurredAt, seq.toString(), event.action, event.resourceType, event.resourceId, JSON.stringify(event.changes), prevHash, hash],
  );
}

export interface CliIo {
  readonly stdout: { write(text: string): unknown; readonly isTTY?: boolean | undefined };
  readonly env: NodeJS.ProcessEnv;
}

/** Point d'entrée testable : le terminal est contrôlé avant toute lecture des arguments sensibles et toute connexion. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<TransferResult> {
  assertTerminal(io.stdout);
  const params = parseCliArgs(argv);
  const url = io.env['MIGRATION_DATABASE_URL'];
  if (!url) throw new CliError('MIGRATION_DATABASE_URL absent : ce script utilise le rôle propriétaire.');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const result = await transferTenantOwner(client, params);
    if (params.allowWithoutTotp) io.stdout.write('Attention : transfert sans second facteur actif (--allow-without-totp), consigné dans l’audit.\n');
    if (result.grantedAdmin) io.stdout.write('Rôle tenant_admin affecté au nouveau principal (--grant-admin), consigné dans l’audit.\n');
    io.stdout.write(`Administrateur principal de « ${params.slug} » : ${params.email} (transfert audité, via cli).\n`);
    return result;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2), { stdout: process.stdout, env: process.env }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof CliError ? error.message : 'Échec inattendu du transfert.'}\n`);
    process.exitCode = 1;
  });
}
