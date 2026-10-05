/**
 * Contrats du module platform (docs/09 §A1, §A5) : realm plateforme (Super Administrateur) et console.
 * Ce fichier n'importe pas ./index (évite les cycles d'évaluation).
 */
import { z } from 'zod';
import { PASSWORD_MAX_LENGTH, PRIVILEGED_PASSWORD_MIN_LENGTH } from './password';
import { email, uuid } from './primitives';
import {
  BILLING_PERIODS,
  PLAN_TIERS,
  SAAS_INVOICE_STATUSES,
  SUBSCRIPTION_STATUSES,
  entitlementOverridesSchema,
  entitlementsSchema,
  type ChangePlanResult,
  type Entitlements,
  type PlanSummary,
  type SaasInvoiceView,
  type SubscriptionView,
} from './subscriptions';

// ───────── Rôles et permissions plateforme ─────────
export const PLATFORM_ROLES = ['super_admin', 'support', 'billing'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const PLATFORM_PERMISSIONS = [
  'tenants:read',
  'tenants:suspend',
  'plans:read',
  'plans:write',
  'subscriptions:read',
  'subscriptions:write',
  'invoices:read',
  'invoices:write',
  'invoices:validate',
  'dashboard:read',
  'audit:read',
] as const;
export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];

/** Matrice : `super_admin` = tout ; `support` = lecture tenants/abonnements ; `billing` = plans, abonnements, factures, paiements manuels. */
export const PLATFORM_ROLE_PERMISSIONS: Readonly<Record<PlatformRole, readonly PlatformPermission[]>> = {
  super_admin: PLATFORM_PERMISSIONS,
  support: ['tenants:read', 'subscriptions:read', 'plans:read', 'dashboard:read'],
  billing: [
    'tenants:read',
    'plans:read',
    'plans:write',
    'subscriptions:read',
    'subscriptions:write',
    'invoices:read',
    'invoices:write',
    'invoices:validate',
    'dashboard:read',
  ],
};

export function platformRoleHas(role: PlatformRole, permission: PlatformPermission): boolean {
  return PLATFORM_ROLE_PERMISSIONS[role].includes(permission);
}

// ───────── Authentification ─────────
export const platformLoginSchema = z.object({ email, password: z.string().min(1).max(PASSWORD_MAX_LENGTH) });
export type PlatformLoginInput = z.infer<typeof platformLoginSchema>;

export const platformMfaVerifySchema = z.object({
  challengeId: z.string().min(16).max(128),
  code: z.string().regex(/^(\d{6}|[A-Z2-9]{10})$/, 'code TOTP (6 chiffres) ou code de secours'),
});
export type PlatformMfaVerifyInput = z.infer<typeof platformMfaVerifySchema>;

export const platformTotpActivateSchema = z.object({ code: z.string().regex(/^\d{6}$/) });
export const platformRefreshSchema = z.object({ refreshToken: z.string().min(16).max(256) });
export const platformLogoutSchema = z.object({ refreshToken: z.string().min(16).max(256).optional() });

export const PLATFORM_ADMIN_PASSWORD_MIN_LENGTH = PRIVILEGED_PASSWORD_MIN_LENGTH;

/** Changement de mot de passe d'un utilisateur plateforme (docs/09 §R, revue sécurité L2). */
export const platformPasswordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: z.string().min(PLATFORM_ADMIN_PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
});
export type PlatformPasswordChangeInput = z.infer<typeof platformPasswordChangeSchema>;

export interface PlatformTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
  /** Un facteur TOTP est activé pour ce compte. */
  readonly mfaEnrolled: boolean;
  /** Toujours vrai : tant que `mfaEnrolled` est faux, seul l'enrôlement est possible. */
  readonly mfaRequired: true;
}

export interface PlatformMfaChallenge {
  readonly mfaRequired: true;
  readonly challengeId: string;
  readonly methods: readonly ('totp' | 'backup_code')[];
}

export type PlatformLoginResponse = PlatformTokens | PlatformMfaChallenge;

export interface PlatformMe {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly role: PlatformRole;
  readonly mfaEnrolled: boolean;
  readonly mfaVerified: boolean;
  readonly permissions: readonly PlatformPermission[];
}

// ───────── Console : entrées ─────────
const pagination = {
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(200).optional(),
};

export const TENANT_STATUSES = ['pending', 'active', 'suspended', 'terminated'] as const;

export const listPlatformTenantsQuerySchema = z.object({
  ...pagination,
  q: z.string().trim().min(1).max(100).optional(),
  status: z.enum(TENANT_STATUSES).optional(),
  subscriptionStatus: z.enum(SUBSCRIPTION_STATUSES).optional(),
});
export type ListPlatformTenantsQuery = z.infer<typeof listPlatformTenantsQuerySchema>;

export const suspendTenantSchema = z.object({ reason: z.string().trim().min(5).max(500) });
export type SuspendTenantInput = z.infer<typeof suspendTenantSchema>;

const decimalString = z.string().regex(/^\d{1,16}(\.\d{1,2})?$/, 'montant décimal, ex. 25000.00');

export const createPlanVersionSchema = z.object({
  code: z.string().min(2).max(50).regex(/^[a-z0-9_]+$/, 'code: minuscules, chiffres et _'),
  name: z.string().trim().min(2).max(100),
  tier: z.enum(PLAN_TIERS),
  priceMonthly: decimalString,
  priceYearly: decimalString,
  currency: z.string().length(3).toUpperCase(),
  entitlements: entitlementsSchema,
  isPublic: z.boolean().default(true),
});
export type CreatePlanVersionInput = z.infer<typeof createPlanVersionSchema>;

export const listPlansQuerySchema = z.object({ includeArchived: z.enum(['true', 'false']).default('false').transform((v) => v === 'true') });

export const platformChangePlanSchema = z.object({
  planCode: z.string().min(2).max(50).regex(/^[a-z0-9_]+$/),
  billingPeriod: z.enum(BILLING_PERIODS),
  overrides: entitlementOverridesSchema.nullable().optional(),
});
export type PlatformChangePlanInput = z.infer<typeof platformChangePlanSchema>;

export const listPlatformInvoicesQuerySchema = z.object({
  ...pagination,
  status: z.enum(SAAS_INVOICE_STATUSES).optional(),
  tenantId: uuid.optional(),
});
export type ListPlatformInvoicesQuery = z.infer<typeof listPlatformInvoicesQuerySchema>;

export const MANUAL_PAYMENT_METHODS = ['bank_transfer', 'cash_reseller', 'cheque', 'other'] as const;
export type ManualPaymentMethod = (typeof MANUAL_PAYMENT_METHODS)[number];

export const createManualPaymentSchema = z.object({
  amount: decimalString,
  method: z.enum(MANUAL_PAYMENT_METHODS),
  reference: z.string().trim().min(2).max(120),
  receivedAt: z.iso.datetime({ offset: true }),
});
export type CreateManualPaymentInput = z.infer<typeof createManualPaymentSchema>;

export const rejectManualPaymentSchema = z.object({ reason: z.string().trim().min(5).max(500) });
export type RejectManualPaymentInput = z.infer<typeof rejectManualPaymentSchema>;

// ───────── Console : sorties ─────────
export interface PlatformTenantUsage {
  readonly users: number;
  readonly sites: number;
  readonly patients: number;
  readonly appointmentsThisMonth: number;
  readonly appointmentsLast30Days: number;
}

export interface PlatformTenantSummary {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly establishmentType: string;
  readonly countryCode: string;
  readonly status: string;
  readonly createdAt: string;
  readonly subscription: { readonly status: string; readonly planCode: string; readonly currentPeriodEnd: string } | null;
}

export interface PlatformDashboard {
  readonly tenants: { readonly total: number; readonly active: number; readonly trial: number; readonly suspended: number };
  readonly users: number;
  readonly patients: number;
  readonly appointmentsLast30Days: number;
  /** Revenu récurrent mensuel par devise, ex. `{ XOF: "1250000.00" }`. */
  readonly mrr: Readonly<Record<string, string>>;
  readonly arr: Readonly<Record<string, string>>;
  readonly overdueInvoices: number;
}

export interface PlatformTenantDetail {
  readonly tenant: PlatformTenantSummary & {
    readonly legalName: string;
    readonly baseCurrency: string;
    readonly timezone: string;
    readonly suspensionReason: string | null;
  };
  readonly subscription: PlatformSubscriptionView | null;
  /** Comptes agrégés uniquement : aucune donnée patient. */
  readonly usage: PlatformTenantUsage;
  readonly modules: readonly string[];
  readonly invoices: { readonly open: number; readonly overdue: number };
}

export interface PlatformSubscriptionView extends SubscriptionView {
  readonly tenantId: string;
  readonly trialExtended: boolean;
  readonly suspensionReason: string | null;
}

export interface PlatformPlanView extends PlanSummary {
  readonly isPublic: boolean;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly entitlements: Entitlements;
}

export interface PlatformInvoiceView extends SaasInvoiceView {
  readonly tenantId: string;
  readonly tenantSlug: string;
}

export interface ManualPaymentView {
  readonly id: string;
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly tenantId: string;
  readonly amount: string;
  readonly currency: string;
  readonly method: ManualPaymentMethod;
  readonly reference: string;
  readonly receivedAt: string;
  readonly status: 'pending' | 'validated' | 'rejected';
  readonly enteredBy: string;
  /** Utilisateur qui a validé ou rejeté (toujours différent du saisisseur). */
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly rejectionReason: string | null;
  readonly createdAt: string;
}

export const listManualPaymentsQuerySchema = z.object({
  ...pagination,
  status: z.enum(['pending', 'validated', 'rejected']).optional(),
});
export type ListManualPaymentsQuery = z.infer<typeof listManualPaymentsQuerySchema>;

export interface PlatformChangePlanResult {
  readonly effect: ChangePlanResult['effect'];
  readonly subscription: PlatformSubscriptionView;
  readonly invoice: SaasInvoiceView | null;
}
