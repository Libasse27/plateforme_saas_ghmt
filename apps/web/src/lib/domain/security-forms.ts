import { loginSchema, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@ghmt/shared';
import { z } from 'zod';
import { fieldErrorsFromZod } from '../forms';
import { CLINICAL_MFA_MODES } from './security';
import type { FormResult } from './admin-forms';

/**
 * Validations locales de la sécurité (docs/11 §9.3) : CIDR, formulaires de réinitialisation et de vérification.
 * Elles reprennent le contrat sans importer `schemas/security.ts` ni `schemas/onboarding.ts` (règle 5 du §0.3).
 */

type Flat = Readonly<Record<string, string | undefined>>;

// ───────── CIDR ─────────
export const TRUSTED_NETWORK_MIN_PREFIX = { v4: 24, v6: 48 } as const;
const V4_BITS = 32;
const V6_BITS = 128;
const OCTET = /^(0|[1-9]\d{0,2})$/;
const HEXTET = /^[0-9a-f]{1,4}$/i;
const PREFIX = /^\d{1,3}$/;
const V6_GROUPS = 8;

export interface ParsedCidr {
  readonly family: 4 | 6;
  readonly prefix: number;
  /** Forme réseau normalisée (bits d'hôte à zéro, IPv6 compressée en minuscules). */
  readonly network: string;
}

function parseV4(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4 || !parts.every((part) => OCTET.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

function hextetsOf(text: string): number[] | null {
  if (text === '') return [];
  const parts = text.split(':');
  return parts.every((part) => HEXTET.test(part)) ? parts.map((part) => parseInt(part, 16)) : null;
}

/** Adresse IPv6 → huit groupes de 16 bits (`::` et suffixe IPv4 gérés) ; null si invalide. */
function parseV6(text: string): number[] | null {
  if (!text.includes(':') || text.includes(':::')) return null;
  let body = text;
  let tail: number[] = [];
  const lastColon = body.lastIndexOf(':');
  const last = body.slice(lastColon + 1);
  if (last.includes('.')) {
    const octets = parseV4(last);
    if (!octets) return null;
    tail = [((octets[0] ?? 0) << 8) | (octets[1] ?? 0), ((octets[2] ?? 0) << 8) | (octets[3] ?? 0)];
    body = body.slice(0, lastColon + 1);
    if (!body.endsWith('::')) body = body.slice(0, -1);
  }
  const halves = body.split('::');
  if (halves.length > 2) return null;
  const head = hextetsOf(halves[0] ?? '');
  const rest = halves.length === 2 ? hextetsOf(halves[1] ?? '') : [];
  if (!head || !rest) return null;
  const known = head.length + rest.length + tail.length;
  if (halves.length === 1) return known === V6_GROUPS ? [...head, ...tail] : null;
  if (known >= V6_GROUPS) return null;
  return [...head, ...new Array<number>(V6_GROUPS - known).fill(0), ...rest, ...tail];
}

function compressV6(groups: readonly number[]): string {
  let bestStart = -1;
  let bestLength = 0;
  for (let start = 0; start < groups.length; ) {
    if (groups[start] !== 0) {
      start += 1;
      continue;
    }
    let end = start;
    while (end < groups.length && groups[end] === 0) end += 1;
    if (end - start > bestLength) {
      bestStart = start;
      bestLength = end - start;
    }
    start = end;
  }
  const hex = (slice: readonly number[]) => slice.map((group) => group.toString(16)).join(':');
  if (bestLength < 2) return hex(groups);
  return `${hex(groups.slice(0, bestStart))}::${hex(groups.slice(bestStart + bestLength))}`;
}

function maskUnits(units: readonly number[], unitBits: number, prefix: number): number[] {
  return units.map((unit, index) => {
    const kept = Math.min(unitBits, Math.max(0, prefix - index * unitBits));
    const mask = kept === 0 ? 0 : ((1 << kept) - 1) << (unitBits - kept);
    return unit & mask;
  });
}

function isMappedV4(groups: readonly number[]): boolean {
  return groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
}

/** Analyse « adresse/préfixe » (IPv4 ou IPv6) ; null si la saisie n'est pas une plage valide. */
export function parseCidr(value: string): ParsedCidr | null {
  if (typeof value !== 'string') return null;
  const parts = value.trim().split('/');
  const [address = '', prefixText = ''] = parts;
  if (parts.length !== 2 || !PREFIX.test(prefixText)) return null;
  const prefix = Number(prefixText);
  const octets = parseV4(address);
  if (octets) {
    if (prefix > V4_BITS) return null;
    return { family: 4, prefix, network: maskUnits(octets, 8, prefix).join('.') };
  }
  const groups = parseV6(address);
  if (!groups || prefix > V6_BITS || isMappedV4(groups)) return null;
  return { family: 6, prefix, network: compressV6(maskUnits(groups, 16, prefix)) };
}

export type CidrCheck =
  | { readonly ok: true; readonly cidr: string }
  | { readonly ok: false; readonly code: 'invalid_cidr' | 'cidr_too_broad'; readonly message: string };

/** Valide une plage de confiance : forme, puis préfixe minimal (/16 en IPv4, /32 en IPv6). */
export function validateCidr(value: string): CidrCheck {
  const parsed = parseCidr(value);
  if (!parsed) {
    const missingPrefix = typeof value === 'string' && !value.includes('/') && value.trim() !== '';
    return {
      ok: false,
      code: 'invalid_cidr',
      message: missingPrefix
        ? 'Indiquez le préfixe de la plage, par exemple 203.0.113.0/24 (ou /32 pour une adresse unique).'
        : 'Plage réseau invalide. Exemple : 203.0.113.0/24.',
    };
  }
  const minimum = parsed.family === 4 ? TRUSTED_NETWORK_MIN_PREFIX.v4 : TRUSTED_NETWORK_MIN_PREFIX.v6;
  if (parsed.prefix < minimum) {
    return { ok: false, code: 'cidr_too_broad', message: `Plage trop large : le préfixe doit être au moins /${String(minimum)} pour l'IPv${String(parsed.family)}.` };
  }
  return { ok: true, cidr: `${parsed.network}/${String(parsed.prefix)}` };
}

/** « Ajouter ce réseau » : l'adresse courante en /32 (IPv4) ou /128 (IPv6), IPv4 encapsulée normalisée ; null sinon. */
export function currentNetworkCidr(ip: string | null | undefined): string | null {
  const address = ip?.trim().toLowerCase().replace(/^::ffff:(?=\d+\.)/, '') ?? '';
  if (address === '') return null;
  if (parseV4(address)) return `${address}/${String(V4_BITS)}`;
  const groups = parseV6(address);
  return groups ? `${compressV6(groups)}/${String(V6_BITS)}` : null;
}

// ───────── Formulaires ─────────
function fail<T>(errors: Record<string, string>): FormResult<T> {
  return { ok: false, errors };
}

function clean(flat: Flat, keys: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of keys) {
    const value = flat[key]?.trim();
    if (value) result[key] = value;
  }
  return result;
}

function parseWith<T>(schema: z.ZodType<T>, input: unknown): FormResult<T> {
  const parsed = schema.safeParse(input);
  return parsed.success ? { ok: true, data: parsed.data } : fail(fieldErrorsFromZod(parsed.error));
}

const LABEL_MIN = 2;
const LABEL_MAX = 80;

const TOTP_CODE = /^\d{6}$/;
const TOTP_ERROR = 'Saisissez le code à 6 chiffres de votre application d\'authentification.';
const REASON_MIN = 10;
const REASON_MAX = 500;

/** Code du second facteur exigé pour les opérations de pouvoir (docs/11 §14.1) : espaces retirés, 6 chiffres. */
function totpCodeOf(flat: Flat): { readonly code: string } | { readonly error: string } {
  const code = (flat.totpCode ?? '').replace(/\s/g, '');
  return TOTP_CODE.test(code) ? { code } : { error: TOTP_ERROR };
}

export interface TrustedNetworkInput {
  readonly cidr: string;
  readonly label: string;
  readonly siteId?: string;
  readonly totpCode: string;
}

export function trustedNetworkForm(flat: Flat): FormResult<TrustedNetworkInput> {
  const input = clean(flat, ['cidr', 'label', 'siteId']);
  const errors: Record<string, string> = {};
  const cidr = validateCidr(input.cidr ?? '');
  if (!cidr.ok) errors.cidr = cidr.message;
  const label = z
    .string()
    .min(LABEL_MIN, `Le libellé doit comporter au moins ${String(LABEL_MIN)} caractères.`)
    .max(LABEL_MAX, `Le libellé ne doit pas dépasser ${String(LABEL_MAX)} caractères.`)
    .safeParse(input.label ?? '');
  if (!label.success) errors.label = label.error.issues[0]?.message ?? 'Libellé invalide.';
  if (input.siteId !== undefined && !z.uuid().safeParse(input.siteId).success) errors.siteId = 'Site invalide.';
  const totp = totpCodeOf(flat);
  if ('error' in totp) errors.totpCode = totp.error;
  if (Object.keys(errors).length > 0 || !cidr.ok || !label.success || 'error' in totp) return fail(errors);
  return { ok: true, data: { cidr: cidr.cidr, label: label.data, ...(input.siteId ? { siteId: input.siteId } : {}), totpCode: totp.code } };
}

export function removeNetworkForm(flat: Flat): FormResult<{ readonly networkId: string; readonly totpCode: string }> {
  const errors: Record<string, string> = {};
  const networkId = z.uuid().safeParse((flat.networkId ?? '').trim());
  if (!networkId.success) errors.networkId = 'Plage invalide.';
  const totp = totpCodeOf(flat);
  if ('error' in totp) errors.totpCode = totp.error;
  if (!networkId.success || 'error' in totp) return fail(errors);
  return { ok: true, data: { networkId: networkId.data, totpCode: totp.code } };
}

export function policyForm(flat: Flat): FormResult<{ readonly clinicalMfa: (typeof CLINICAL_MFA_MODES)[number]; readonly totpCode: string }> {
  const errors: Record<string, string> = {};
  const mode = z.enum(CLINICAL_MFA_MODES, { error: 'Choisissez une option.' }).safeParse((flat.clinicalMfa ?? '').trim());
  if (!mode.success) errors.clinicalMfa = 'Choisissez une option.';
  const totp = totpCodeOf(flat);
  if ('error' in totp) errors.totpCode = totp.error;
  if (!mode.success || 'error' in totp) return fail(errors);
  return { ok: true, data: { clinicalMfa: mode.data, totpCode: totp.code } };
}

export function transferOwnerForm(flat: Flat): FormResult<{ readonly userId: string; readonly totpCode: string }> {
  const errors: Record<string, string> = {};
  const userId = z.uuid().safeParse((flat.userId ?? '').trim());
  if (!userId.success) errors.userId = 'Choisissez un administrateur.';
  const totp = totpCodeOf(flat);
  if ('error' in totp) errors.totpCode = totp.error;
  if (!userId.success || 'error' in totp) return fail(errors);
  return { ok: true, data: { userId: userId.data, totpCode: totp.code } };
}

/** Motif obligatoire (10 à 500 caractères) de la réinitialisation du second facteur et du déverrouillage. */
export function reasonForm(flat: Flat): FormResult<{ readonly reason: string }> {
  const reason = (flat.reason ?? '').trim();
  if (reason.length < REASON_MIN || reason.length > REASON_MAX) {
    return fail({ reason: `Indiquez le motif, de ${String(REASON_MIN)} à ${String(REASON_MAX)} caractères.` });
  }
  return { ok: true, data: { reason } };
}

// ───────── Mot de passe oublié, réinitialisation, vérification d'inscription ─────────
const LINK_TOKEN = /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{20,}$/;
const LINK_TOKEN_MIN = 32;
const LINK_TOKEN_MAX = 256;
const MFA_CODE_SEPARATORS = /[\s-]/g;
const MFA_CODE = /^(\d{6}|[A-Z2-9]{10})$/;

/** Jeton `<uuid>.<secret>` reçu par e-mail : refuse tout ce qui pourrait altérer un chemin ou une requête. */
export function isOpaqueLinkToken(value: string): boolean {
  return value.length >= LINK_TOKEN_MIN && value.length <= LINK_TOKEN_MAX && LINK_TOKEN.test(value);
}

const TENANT_SLUG = /^(?=.{3,48}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Code établissement (même règle que l'inscription) : seul un code valide est repris dans une URL de redirection. */
export function safeTenantSlug(candidate: string | undefined | null): string | null {
  return candidate && TENANT_SLUG.test(candidate) ? candidate : null;
}

const identity = loginSchema.pick({ tenantSlug: true, email: true });

function identityForm(flat: Flat): FormResult<{ readonly tenantSlug: string; readonly email: string }> {
  return parseWith(identity, { tenantSlug: (flat.tenantSlug ?? '').trim().toLowerCase(), email: (flat.email ?? '').trim() });
}

export const forgotPasswordForm = identityForm;
export const resendVerificationForm = identityForm;

export interface ResetPasswordInput {
  readonly token: string;
  readonly newPassword: string;
  readonly mfaCode?: string;
}

export function resetPasswordForm(flat: Flat): FormResult<ResetPasswordInput> {
  const errors: Record<string, string> = {};
  const token = flat.token ?? '';
  if (!isOpaqueLinkToken(token)) errors.token = 'Ce lien n\'est pas valide.';
  const password = flat.newPassword ?? '';
  if (password.length < PASSWORD_MIN_LENGTH) errors.newPassword = `Le mot de passe doit comporter au moins ${String(PASSWORD_MIN_LENGTH)} caractères.`;
  else if (password.length > PASSWORD_MAX_LENGTH) errors.newPassword = `Le mot de passe ne doit pas dépasser ${String(PASSWORD_MAX_LENGTH)} caractères.`;
  if (password !== (flat.confirmPassword ?? '')) errors.confirmPassword = 'Les mots de passe ne correspondent pas.';
  const code = (flat.mfaCode ?? '').replace(MFA_CODE_SEPARATORS, '').toUpperCase();
  if (code !== '' && !MFA_CODE.test(code)) errors.mfaCode = 'Saisissez le code à 6 chiffres de votre application, ou un code de secours.';
  if (Object.keys(errors).length > 0) return fail(errors);
  return { ok: true, data: { token, newPassword: password, ...(code ? { mfaCode: code } : {}) } };
}
