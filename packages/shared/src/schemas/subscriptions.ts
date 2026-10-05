/**
 * Contrats du module subscriptions (docs/09 §A2-A4) : plans, droits (entitlements), abonnement du tenant, factures SaaS.
 * Montants : chaînes décimales (`"25000.00"`), jamais de flottant. Dates : ISO 8601.
 */
import { z } from 'zod';
import { phoneE164 } from './primitives';
import type { EstablishmentType } from './index';

export const SUBSCRIPTION_STATUSES = ['trial', 'active', 'past_due', 'grace', 'suspended', 'cancelled', 'expired'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const BILLING_PERIODS = ['monthly', 'yearly'] as const;
export type BillingPeriod = (typeof BILLING_PERIODS)[number];

export const PLAN_TIERS = ['basic', 'standard', 'professional', 'enterprise'] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

export const SAAS_INVOICE_STATUSES = ['draft', 'open', 'paid', 'void', 'uncollectible'] as const;
export type SaasInvoiceStatus = (typeof SAAS_INVOICE_STATUSES)[number];

export const SAAS_INVOICE_KINDS = ['renewal', 'conversion', 'upgrade_prorata'] as const;
export type SaasInvoiceKind = (typeof SAAS_INVOICE_KINDS)[number];

// ───────── Droits (entitlements) ─────────
export const ENTITLEMENT_LIMIT_KEYS = ['users', 'sites', 'appointmentsMonthly', 'activePatients', 'smsMonthly', 'storageGb'] as const;
export type EntitlementLimitKey = (typeof ENTITLEMENT_LIMIT_KEYS)[number];

export const ENTITLEMENT_FEATURE_KEYS = ['customRoles', 'export', 'api'] as const;
export type EntitlementFeatureKey = (typeof ENTITLEMENT_FEATURE_KEYS)[number];

/** `null` = illimité. */
const limitValue = z.number().int().min(0).nullable();

export const entitlementLimitsSchema = z.object({
  users: limitValue,
  sites: limitValue,
  appointmentsMonthly: limitValue,
  activePatients: limitValue,
  smsMonthly: limitValue,
  storageGb: limitValue,
});

export const entitlementFeaturesSchema = z.object({ customRoles: z.boolean(), export: z.boolean(), api: z.boolean() });

export const entitlementsSchema = z.object({
  modules: z.array(z.string().min(1).max(50)).max(50),
  limits: entitlementLimitsSchema,
  features: entitlementFeaturesSchema,
});
export type Entitlements = z.infer<typeof entitlementsSchema>;

/** Dérogations négociées (`subscriptions.overrides`) : modules ajoutés, limites et fonctionnalités remplacées. */
export const entitlementOverridesSchema = z
  .object({
    modules: z.array(z.string().min(1).max(50)).max(50).optional(),
    limits: entitlementLimitsSchema.partial().optional(),
    features: entitlementFeaturesSchema.partial().optional(),
  })
  .strict();
export type EntitlementOverrides = z.infer<typeof entitlementOverridesSchema>;

/** Droits effectifs = plan ⊕ dérogations : modules en union, limites et fonctionnalités remplacées clé par clé. */
export function mergeEntitlements(base: Entitlements, overrides: EntitlementOverrides | null | undefined): Entitlements {
  if (!overrides) return base;
  const limits = { ...base.limits };
  for (const key of ENTITLEMENT_LIMIT_KEYS) {
    const value = overrides.limits?.[key];
    if (value !== undefined) limits[key] = value;
  }
  const features = { ...base.features };
  for (const key of ENTITLEMENT_FEATURE_KEYS) {
    const value = overrides.features?.[key];
    if (value !== undefined) features[key] = value;
  }
  return { modules: [...new Set([...base.modules, ...(overrides.modules ?? [])])].sort(), limits, features };
}

// ───────── Entrées tenant ─────────
export const changePlanSchema = z.object({
  planCode: z.string().min(2).max(50).regex(/^[a-z0-9_]+$/),
  billingPeriod: z.enum(BILLING_PERIODS),
});
export type ChangePlanInput = z.infer<typeof changePlanSchema>;

export const payInvoiceSchema = z.object({ payerPhone: phoneE164 });
export type PayInvoiceInput = z.infer<typeof payInvoiceSchema>;

export const listSaasInvoicesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(200).optional(),
  status: z.enum(SAAS_INVOICE_STATUSES).optional(),
});
export type ListSaasInvoicesQuery = z.infer<typeof listSaasInvoicesQuerySchema>;

// ───────── Sorties ─────────
export interface PlanSummary {
  readonly id: string;
  readonly code: string;
  readonly version: number;
  readonly name: string;
  readonly tier: PlanTier;
  readonly priceMonthly: string;
  readonly priceYearly: string;
  readonly currency: string;
}

/** Offre publique proposée au changement de plan (`GET /subscription/plans`). */
export interface PublicPlanView extends PlanSummary {
  readonly entitlements: Entitlements;
  /** Faux pour une offre non sélectionnable dans l'état actuel (en essai : seules basic et standard le sont). */
  readonly selectable: boolean;
}

/** Mode d'accès de l'établissement selon l'abonnement : normal, restreint (grâce) ou continuité des soins (suspendu, résilié, expiré). */
export const SUBSCRIPTION_ACCESS_MODES = ['normal', 'restricted', 'continuity'] as const;
export type SubscriptionAccessMode = (typeof SUBSCRIPTION_ACCESS_MODES)[number];

/** `GET /subscription/status` : lisible par tout utilisateur de l'établissement, sans donnée financière. */
export interface SubscriptionStatusView {
  readonly status: SubscriptionStatus;
  readonly trialEndsAt: string | null;
  readonly daysLeft: number | null;
  readonly mode: SubscriptionAccessMode;
}

/** Offres sélectionnables pendant l'essai. */
export const TRIAL_SELECTABLE_PLAN_CODES = ['basic', 'standard'] as const;

export interface SubscriptionUsage {
  readonly users: number;
  readonly sites: number;
  readonly appointmentsThisMonth: number;
}

export interface PendingPlanChange {
  readonly planCode: string;
  readonly billingPeriod: BillingPeriod;
  /** Date d'effet : fin de la période courante. */
  readonly effectiveAt: string;
}

export interface SubscriptionView {
  readonly id: string;
  readonly status: SubscriptionStatus;
  readonly billingPeriod: BillingPeriod;
  readonly currentPeriodStart: string;
  readonly currentPeriodEnd: string;
  readonly trialEndsAt: string | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly plan: PlanSummary;
  readonly pendingChange: PendingPlanChange | null;
  readonly entitlements: Entitlements;
  readonly usage: SubscriptionUsage;
}

export interface SaasInvoiceLineView {
  readonly description: string;
  readonly quantity: number;
  readonly unitPrice: string;
  readonly amount: string;
}

export interface SaasInvoiceView {
  readonly id: string;
  readonly number: string;
  readonly status: SaasInvoiceStatus;
  readonly kind: SaasInvoiceKind;
  readonly currency: string;
  readonly subtotal: string;
  /** Taux décimal, ex. `"0.1800"`. */
  readonly taxRate: string;
  readonly taxAmount: string;
  readonly total: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly issuedAt: string;
  readonly dueAt: string;
  readonly paidAt: string | null;
  readonly lines: readonly SaasInvoiceLineView[];
}

export interface PayInvoiceView {
  readonly attemptId: string;
  readonly status: string;
  readonly provider: string;
  readonly checkoutUrl: string | null;
  readonly instructions: string | null;
}

/** Résultat de `POST /subscription/change`. */
export interface ChangePlanResult {
  /**
   * `immediate` : appliqué tout de suite (upgrade, essai) ; `scheduled` : appliqué à la fin de la période courante ;
   * `pending_payment` : réactivation (expiré, suspendu, résilié), le plan s'applique au paiement de la facture émise.
   */
  readonly effect: 'immediate' | 'scheduled' | 'pending_payment';
  readonly subscription: SubscriptionView;
  /** Facture de prorata ou de conversion émise, le cas échéant. */
  readonly invoice: SaasInvoiceView | null;
}

/** Dépassement détecté lors d'un downgrade (409 `downgrade_incompatible`). */
export interface DowngradeViolation {
  readonly metric: 'users' | 'sites';
  readonly limit: number;
  readonly current: number;
}

// ───────── Catalogue initial des plans (docs/05 A2, prix indicatifs en XOF) ─────────
export interface PlanCatalogEntry {
  readonly code: string;
  readonly name: string;
  readonly tier: PlanTier;
  readonly priceMonthly: string;
  readonly priceYearly: string;
  readonly currency: string;
  readonly entitlements: Entitlements;
}

const BASIC_MODULES = ['appointments', 'billing', 'cashier'] as const;
const STANDARD_MODULES = [...BASIC_MODULES, 'consultations', 'inventory', 'laboratory', 'pharmacy'] as const;
const PROFESSIONAL_MODULES = [...STANDARD_MODULES, 'imaging', 'inpatient', 'maternity', 'nursing'] as const;
const ENTERPRISE_MODULES = [...PROFESSIONAL_MODULES, 'accounting', 'hr'] as const;

/** Plans de départ (version 1) : tous incluent `billing` et `cashier`. `null` = illimité. */
export const DEFAULT_PLAN_CATALOG: readonly PlanCatalogEntry[] = [
  {
    code: 'basic',
    name: 'Basic',
    tier: 'basic',
    priceMonthly: '25000.00',
    priceYearly: '250000.00',
    currency: 'XOF',
    entitlements: {
      modules: [...BASIC_MODULES],
      limits: { users: 5, sites: 1, appointmentsMonthly: 500, activePatients: 2000, smsMonthly: 200, storageGb: 5 },
      features: { customRoles: false, export: false, api: false },
    },
  },
  {
    code: 'standard',
    name: 'Standard',
    tier: 'standard',
    priceMonthly: '75000.00',
    priceYearly: '750000.00',
    currency: 'XOF',
    entitlements: {
      modules: [...STANDARD_MODULES],
      limits: { users: 25, sites: 2, appointmentsMonthly: 3000, activePatients: 15000, smsMonthly: 1000, storageGb: 50 },
      features: { customRoles: true, export: true, api: true },
    },
  },
  {
    code: 'professional',
    name: 'Professional',
    tier: 'professional',
    priceMonthly: '200000.00',
    priceYearly: '2000000.00',
    currency: 'XOF',
    entitlements: {
      modules: [...PROFESSIONAL_MODULES],
      limits: { users: 100, sites: 5, appointmentsMonthly: 15000, activePatients: 75000, smsMonthly: 5000, storageGb: 250 },
      features: { customRoles: true, export: true, api: true },
    },
  },
  {
    code: 'enterprise',
    name: 'Enterprise',
    tier: 'enterprise',
    priceMonthly: '500000.00',
    priceYearly: '5000000.00',
    currency: 'XOF',
    entitlements: {
      modules: [...ENTERPRISE_MODULES],
      limits: { users: null, sites: null, appointmentsMonthly: null, activePatients: null, smsMonthly: 20000, storageGb: 1024 },
      features: { customRoles: true, export: true, api: true },
    },
  },
];

/** Entités de facturation de départ : TVA par pays, à valider avec un conseil fiscal local (docs/05 A9). `ZZ` = repli international. */
export const DEFAULT_BILLING_ENTITIES: readonly {
  readonly countryCode: string;
  readonly legalName: string;
  readonly currency: string;
  readonly taxRate: string;
}[] = [
  { countryCode: 'SN', legalName: 'GHMT Sénégal', currency: 'XOF', taxRate: '0.1800' },
  { countryCode: 'CI', legalName: 'GHMT Côte d’Ivoire', currency: 'XOF', taxRate: '0.1800' },
  { countryCode: 'CM', legalName: 'GHMT Cameroun', currency: 'XAF', taxRate: '0.1925' },
  { countryCode: 'CD', legalName: 'GHMT RDC', currency: 'USD', taxRate: '0.1600' },
  { countryCode: 'ZZ', legalName: 'GHMT International', currency: 'XOF', taxRate: '0.0000' },
];

// ───────── Essai gratuit (docs/05 A3, A5) ─────────
/** Durée de l'essai gratuit en jours. */
export const TRIAL_DAYS = 30;

export type TrialPlanCode = 'basic' | 'standard';

/**
 * Plan d'essai selon le type d'établissement (docs/05 A3), plafonné à Standard (docs/05 A5) :
 * cabinet, pharmacie, laboratoire → Basic ; centres, cliniques, hôpitaux → Standard (Professional/Enterprise plafonnés).
 */
export function trialPlanCodeFor(type: EstablishmentType): TrialPlanCode {
  switch (type) {
    case 'private_practice':
    case 'pharmacy':
    case 'laboratory':
    case 'other':
      return 'basic';
    default:
      return 'standard';
  }
}
