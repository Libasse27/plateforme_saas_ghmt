/**
 * Contrats de la phase durcissement sécurité (équipe AUTH, docs/11-phase-durcissement-securite.md §7.1).
 * Pas d'import de ./index ici (dépendance circulaire à l'évaluation).
 */
import { z } from 'zod';
import { passwordSchema } from './password';
import { email, tenantSlug, uuid } from './primitives';

// ───────── Constantes ─────────
export const CLINICAL_MFA_MODES = ['off_network', 'always'] as const;
export type ClinicalMfaMode = (typeof CLINICAL_MFA_MODES)[number];

/** Modules dont au moins une permission fait d'un rôle un rôle « clinique » (D5, calculé sur les permissions effectives). */
export const CLINICAL_PERMISSION_MODULES = ['consultations', 'nursing', 'maternity', 'inpatient', 'laboratory', 'imaging', 'pharmacy'] as const;

export const TRUSTED_NETWORK_MAX = 50;
/** Préfixe minimal d'une plage de confiance : au-delà (plus large), la plage est refusée. */
export const TRUSTED_NETWORK_MIN_PREFIX = { v4: 24, v6: 48 } as const;

/** Délai (secondes) avant d'examiner la tentative suivante, indexé par `échecs consécutifs − 1` (D3). Le dernier palier fait plafond. */
export const LOGIN_DELAY_SECONDS: readonly number[] = [0, 0, 0, 0, 30, 60, 120, 300, 600, 900];

export const PASSWORD_RESET_TTL_MINUTES = 30;
export const MFA_EMAIL_CODE_TTL_MINUTES = 10;

const MFA_CODE_PATTERN = /^(\d{6}|[A-Z2-9]{10})$/;
const RESET_TOKEN_PATTERN = /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{20,}$/;

/**
 * Permissions de stock de la pharmacie : elles n'ouvrent aucune donnée de soin et ne rendent pas un rôle clinique
 * (gestionnaire de stock, décision 22). La dispensation et la modification du catalogue de médicaments restent cliniques.
 */
const NON_CLINICAL_PERMISSIONS: ReadonlySet<string> = new Set(['pharmacy:drug:read', 'pharmacy:stock_movement:read', 'pharmacy:stock_movement:create']);

/** Une permission est clinique si son module figure dans `CLINICAL_PERMISSION_MODULES` (hors stock pharmacie). */
export function isClinicalPermission(permission: string): boolean {
  if (NON_CLINICAL_PERMISSIONS.has(permission)) return false;
  const module = permission.split(':')[0] ?? '';
  return (CLINICAL_PERMISSION_MODULES as readonly string[]).includes(module);
}

/** Délai imposé avant la prochaine tentative après `consecutiveFailures` échecs consécutifs (0 : aucun). */
export function loginDelaySeconds(consecutiveFailures: number): number {
  if (!Number.isFinite(consecutiveFailures) || consecutiveFailures < 1) return 0;
  const index = Math.min(Math.floor(consecutiveFailures), LOGIN_DELAY_SECONDS.length) - 1;
  return LOGIN_DELAY_SECONDS[index] ?? 0;
}

// ───────── Analyse d'une plage réseau (CIDR), sans dépendance ─────────
export interface ParsedCidr {
  readonly family: 4 | 6;
  readonly prefix: number;
  /** Forme réseau normalisée (bits d'hôte à zéro), IPv6 compressée en minuscules. */
  readonly network: string;
}

const IPV4_OCTET = /^(0|[1-9]\d{0,2})$/;
const PREFIX = /^(0|[1-9]\d{0,2})$/;
const HEXTET = /^[0-9a-fA-F]{1,4}$/;
const MAPPED_V4_PREFIX = 96;

function parseIpv4(text: string): bigint | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!IPV4_OCTET.test(part) || Number(part) > 255) return null;
    value = (value << 8n) | BigInt(part);
  }
  return value;
}

function parseHextets(text: string): number[] | null {
  if (text === '') return [];
  const hextets: number[] = [];
  for (const part of text.split(':')) {
    if (!HEXTET.test(part)) return null;
    hextets.push(parseInt(part, 16));
  }
  return hextets;
}

function parseIpv6(text: string): bigint | null {
  let source = text;
  let tail: number[] = [];
  const lastColon = source.lastIndexOf(':');
  if (lastColon >= 0 && source.slice(lastColon + 1).includes('.')) {
    const embedded = parseIpv4(source.slice(lastColon + 1));
    if (embedded === null) return null;
    source = `${source.slice(0, lastColon + 1)}0:0`;
    tail = [Number(embedded >> 16n) & 0xffff, Number(embedded & 0xffffn)];
  }
  const halves = source.split('::');
  if (halves.length > 2) return null;
  const head = parseHextets(halves[0]!);
  const rest = halves.length === 2 ? parseHextets(halves[1]!) : [];
  if (head === null || rest === null) return null;
  let groups: number[];
  if (halves.length === 2) {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  if (tail.length === 2) groups = [...groups.slice(0, 6), tail[0]!, tail[1]!];
  return groups.reduce<bigint>((acc, group) => (acc << 16n) | BigInt(group), 0n);
}

function maskHostBits(value: bigint, bits: number, prefix: number): bigint {
  const hostBits = BigInt(bits - prefix);
  return (value >> hostBits) << hostBits;
}

function formatIpv4(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 0xffn)).join('.');
}

/** Plus longue suite de groupes nuls (au moins 2), la première en cas d'égalité (RFC 5952). */
function longestZeroRun(groups: readonly number[]): { start: number; length: number } {
  let best = { start: -1, length: 0 };
  let current = { start: -1, length: 0 };
  groups.forEach((group, index) => {
    if (group !== 0) {
      current = { start: -1, length: 0 };
      return;
    }
    if (current.start < 0) current = { start: index, length: 0 };
    current = { ...current, length: current.length + 1 };
    if (current.length > best.length) best = current;
  });
  return best.length >= 2 ? best : { start: -1, length: 0 };
}

function formatIpv6(value: bigint): string {
  const groups = Array.from({ length: 8 }, (_, index) => Number((value >> BigInt((7 - index) * 16)) & 0xffffn));
  const run = longestZeroRun(groups);
  if (run.start < 0) return groups.map((group) => group.toString(16)).join(':');
  const before = groups.slice(0, run.start).map((group) => group.toString(16)).join(':');
  const after = groups.slice(run.start + run.length).map((group) => group.toString(16)).join(':');
  return `${before}::${after}`;
}

/**
 * Analyse `a.b.c.d/n` ou `x:y::z/n`. Renvoie `null` si la valeur est mal formée. Le préfixe minimal n'est pas contrôlé ici
 * (voir `TRUSTED_NETWORK_MIN_PREFIX`). Une adresse IPv4 encapsulée `::ffff:a.b.c.d` est ramenée à son IPv4.
 */
export function parseCidr(value: string): ParsedCidr | null {
  if (typeof value !== 'string') return null;
  const pieces = value.trim().split('/');
  if (pieces.length !== 2 || !PREFIX.test(pieces[1]!)) return null;
  const address = pieces[0]!;
  const prefix = Number(pieces[1]);

  if (!address.includes(':')) {
    const ipv4 = parseIpv4(address);
    if (ipv4 === null || prefix > 32) return null;
    return { family: 4, prefix, network: `${formatIpv4(maskHostBits(ipv4, 32, prefix))}/${prefix}` };
  }
  const ipv6 = parseIpv6(address);
  if (ipv6 === null || prefix > 128) return null;
  const isMapped = ipv6 >> 32n === 0xffffn;
  if (isMapped && prefix >= MAPPED_V4_PREFIX) {
    const v4Prefix = prefix - MAPPED_V4_PREFIX;
    return { family: 4, prefix: v4Prefix, network: `${formatIpv4(maskHostBits(ipv6 & 0xffffffffn, 32, v4Prefix))}/${v4Prefix}` };
  }
  return { family: 6, prefix, network: `${formatIpv6(maskHostBits(ipv6, 128, prefix))}/${prefix}` };
}

// ───────── Plages réservées (décision 23) ─────────
const RESERVED_V4: readonly string[] = [
  // Usage local, privé, partagé, bouclage, lien local, multicast, réservé, documentation, évaluation
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
];

const RESERVED_V6: readonly string[] = [
  // IPv4 compatibles (dont non spécifiée et bouclage) et IPv4 encapsulées : jamais sous forme IPv6
  '::/96',
  '::ffff:0:0/96',
  // Transition (NAT64, 6to4, Teredo), rejet, locales uniques, lien local, multicast, documentation
  '64:ff9b::/96',
  '100::/64',
  '2001::/32',
  '2002::/16',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
  '2001:db8::/32',
];

interface RawBlock {
  readonly family: 4 | 6;
  readonly value: bigint;
  readonly prefix: number;
}

/** Bloc analysé SANS la conversion des IPv4 encapsulées de `parseCidr` (`::ffff:0:0/96` doit rester un bloc IPv6). */
function rawBlock(text: string, family: 4 | 6): RawBlock {
  const [address, prefix] = text.split('/') as [string, string];
  const bits = family === 4 ? 32 : 128;
  const value = (family === 4 ? parseIpv4(address) : parseIpv6(address)) ?? 0n;
  return { family, value: maskHostBits(value, bits, Number(prefix)), prefix: Number(prefix) };
}

const RESERVED_BLOCKS: readonly RawBlock[] = [...RESERVED_V4.map((b) => rawBlock(b, 4)), ...RESERVED_V6.map((b) => rawBlock(b, 6))];

function networkValue(network: string): bigint {
  const address = network.slice(0, network.indexOf('/'));
  return (address.includes(':') ? parseIpv6(address) : parseIpv4(address)) ?? 0n;
}

/**
 * Le réseau CHEVAUCHE-t-il un bloc réservé (inclus dedans ou le contenant) ? Deux plages se chevauchent si elles coïncident
 * sur le plus court de leurs deux préfixes.
 */
export function isReservedNetwork(parsed: ParsedCidr): boolean {
  const bits = parsed.family === 4 ? 32 : 128;
  const value = networkValue(parsed.network);
  return RESERVED_BLOCKS.some((block) => {
    if (block.family !== parsed.family) return false;
    const common = Math.min(block.prefix, parsed.prefix);
    return maskHostBits(value, bits, common) === maskHostBits(block.value, bits, common);
  });
}

/** Adresse privée, spéciale, mal formée ou absente ⇒ jamais une IP de confiance (une plage publique ne la couvrirait pas). */
export function isReservedAddress(ip: string): boolean {
  const parsed = parseCidr(`${ip}/${ip.includes(':') ? 128 : 32}`);
  return parsed === null || isReservedNetwork(parsed);
}

// ───────── Schémas ─────────
/** Code TOTP récent exigé pour les opérations de pouvoir : facultatif ici, l'API répond 401 `mfa_step_up_required` s'il manque. */
const totpCodeField = z.string().regex(/^\d{6}$/, 'code TOTP à 6 chiffres').optional();
export const forgotPasswordSchema = z.object({ tenantSlug, email });
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const passwordResetTokenSchema = z.object({ token: z.string().min(32).max(256).regex(RESET_TOKEN_PATTERN) });
export type PasswordResetTokenInput = z.infer<typeof passwordResetTokenSchema>;

export const resetPasswordSchema = z.object({
  token: z.string().min(32).max(256).regex(RESET_TOKEN_PATTERN),
  newPassword: passwordSchema,
  mfaCode: z.string().regex(MFA_CODE_PATTERN, 'code TOTP (6 chiffres) ou code de secours').optional(),
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

/** Corps facultatif de `POST /auth/mfa/totp/setup` : code reçu par e-mail, exigé hors réseau de confiance. */
export const mfaSetupSchema = z.object({ emailCode: z.string().regex(/^\d{6}$/, 'code à 6 chiffres').optional() });
export type MfaSetupInput = z.infer<typeof mfaSetupSchema>;

export const updateSecurityPolicySchema = z.object({ clinicalMfa: z.enum(CLINICAL_MFA_MODES), totpCode: totpCodeField });
export type UpdateSecurityPolicyInput = z.infer<typeof updateSecurityPolicySchema>;

/** La validité du CIDR (`invalid_cidr`, `cidr_too_broad`) est contrôlée par l'API avec `parseCidr` pour renvoyer un code précis. */
export const createTrustedNetworkSchema = z.object({
  cidr: z.string().trim().min(3).max(64),
  label: z.string().trim().min(2).max(80),
  siteId: uuid.optional(),
  totpCode: totpCodeField,
});
export type CreateTrustedNetworkInput = z.infer<typeof createTrustedNetworkSchema>;

export const removeTrustedNetworkSchema = z.object({ totpCode: totpCodeField });
export type RemoveTrustedNetworkInput = z.infer<typeof removeTrustedNetworkSchema>;

export const transferOwnershipSchema = z.object({ userId: uuid, totpCode: totpCodeField });
export type TransferOwnershipInput = z.infer<typeof transferOwnershipSchema>;

/** Motif obligatoire (réinitialisation du second facteur, déverrouillage) : repris dans l'audit. */
export const reasonSchema = z.object({ reason: z.string().trim().min(10).max(500) });
export type ReasonInput = z.infer<typeof reasonSchema>;

// ───────── Vues ─────────
export interface PasswordResetPreview {
  readonly tenantSlug: string;
  readonly emailMasked: string;
  readonly mfaRequired: boolean;
}

export interface TrustedNetworkView {
  readonly id: string;
  readonly cidr: string;
  readonly label: string;
  readonly siteId: string | null;
  readonly createdAt: string;
  readonly createdBy: { readonly id: string; readonly fullName: string } | null;
}

export interface SecurityPolicyView {
  readonly clinicalMfa: ClinicalMfaMode;
  readonly trustedNetworks: readonly TrustedNetworkView[];
  readonly requestIp: string | null;
  readonly requestIpTrusted: boolean;
  /** Utilisateurs actifs à rôle clinique sans second facteur actif. */
  readonly clinicalUsersWithoutMfa: number;
  /** Vrai pour l'administrateur principal seul. */
  readonly canManage: boolean;
  readonly owner: { readonly id: string; readonly fullName: string } | null;
  readonly updatedAt: string | null;
}

export interface MfaEmailCodeResponse {
  readonly sent: true;
  readonly emailMasked: string;
}
