/**
 * Contrats de la phase durcissement sécurité (équipe OPS, docs/11-phase-durcissement-securite.md §7.2) :
 * slugs réservés et vérification de l'adresse e-mail à l'inscription.
 * Pas d'import de ./index ici (dépendance circulaire à l'évaluation).
 */
import { z } from 'zod';
import { email, tenantSlug } from './primitives';

/**
 * Identifiants d'établissement interdits à l'inscription (D13) : ils usurperaient une adresse de la plateforme
 * ou prêteraient à confusion (hameçonnage). Recopiés dans `platform.reserved_slugs` par la migration
 * `20261006000200_signup_hardening` ; un test e2e vérifie que les deux listes restent identiques.
 */
export const RESERVED_TENANT_SLUGS: readonly string[] = [
  'www', 'api', 'app', 'admin', 'administration', 'plateforme', 'platform', 'console', 'support', 'aide', 'help',
  'status', 'statut', 'mail', 'smtp', 'imap', 'static', 'assets', 'cdn', 'docs', 'blog', 'auth', 'login', 'connexion',
  'inscription', 'signup', 'compte', 'account', 'billing', 'facturation', 'paiement', 'payment', 'security', 'securite',
  'dev', 'staging', 'preprod', 'prod', 'test', 'demo', 'sandbox', 'internal', 'system', 'root', 'null', 'undefined',
];

/** `xn--` (domaines punycode, homographes) et `ghmt` (marque de la plateforme). */
export const RESERVED_SLUG_PREFIXES: readonly string[] = ['xn--', 'ghmt'];

const RESERVED_SET: ReadonlySet<string> = new Set(RESERVED_TENANT_SLUGS);

/** Vrai si l'identifiant est réservé (liste exacte ou préfixe), sans tenir compte de la casse ni des espaces. */
export function isReservedTenantSlug(slug: string): boolean {
  const normalized = slug.trim().toLowerCase();
  return RESERVED_SET.has(normalized) || RESERVED_SLUG_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/** Durée de validité du jeton de vérification d'inscription. */
export const SIGNUP_VERIFICATION_TTL_HOURS = 24;
/** Au-delà, une inscription non confirmée expire : le tenant est supprimé et son identifiant libéré. */
export const PENDING_SIGNUP_EXPIRY_DAYS = 7;

/** Jeton opaque `<tenantId>.<secret>` reçu par e-mail, transmis dans le corps (jamais dans une URL de l'API, D1). */
const signupVerificationToken = z
  .string()
  .min(32)
  .max(256)
  .regex(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{20,}$/, 'jeton de vérification invalide');

export const verifySignupSchema = z.object({ token: signupVerificationToken });
export type VerifySignupInput = z.infer<typeof verifySignupSchema>;

export const resendSignupVerificationSchema = z.object({ tenantSlug, email });
export type ResendSignupVerificationInput = z.infer<typeof resendSignupVerificationSchema>;

export interface SignupVerificationResult {
  readonly tenantSlug: string;
}
