import {
  MANUAL_PAYMENT_METHODS,
  createManualPaymentSchema,
  createPlanVersionSchema,
  type CreateManualPaymentInput,
  type CreatePlanVersionInput,
  type ManualPaymentView,
  type PlatformDashboard,
  type PlatformPlanView,
  type PlatformInvoiceView,
  type PlatformSubscriptionView,
  type PlatformTenantDetail,
  type PlatformTenantSummary,
} from '@ghmt/shared';
import { fieldErrorsFromZod } from '../forms';
import { isDayString } from '../format/dates';
import { formatMoney, parseMoneyInput } from './money';
import { amount, bool, num, rec, str, strOrNull, strings } from './raw';
import { toEntitlements, toPublicPlan, toSaasInvoice, toSubscription } from './subscription';

export const TENANT_STATUS_LABELS: Readonly<Record<string, string>> = {
  pending: 'En attente',
  active: 'Actif',
  suspended: 'Suspendu',
  terminated: 'Résilié',
};

export const MANUAL_METHOD_LABELS: Readonly<Record<string, string>> = {
  bank_transfer: 'Virement bancaire',
  cash_reseller: 'Espèces (revendeur)',
  cheque: 'Chèque',
  other: 'Autre',
};

export const MANUAL_STATUS_LABELS: Readonly<Record<string, string>> = { pending: 'En attente de validation', validated: 'Validé', rejected: 'Rejeté' };

function counts(raw: unknown) {
  return rec(raw);
}

function moneyRecord(raw: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(rec(raw)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

export function toPlatformDashboard(raw: unknown): PlatformDashboard {
  const d = rec(raw);
  const tenants = counts(d.tenants);
  return {
    tenants: { total: num(tenants.total), active: num(tenants.active), trial: num(tenants.trial), suspended: num(tenants.suspended) },
    users: num(d.users),
    patients: num(d.patients),
    appointmentsLast30Days: num(d.appointmentsLast30Days),
    mrr: moneyRecord(d.mrr),
    arr: moneyRecord(d.arr),
    overdueInvoices: num(d.overdueInvoices),
  };
}

/** « 1 250 000 FCFA · 100,00 EUR » ; un revenu par devise. */
export function moneyByCurrency(values: Readonly<Record<string, string>>): string {
  const entries = Object.entries(values);
  return entries.length === 0 ? '-' : entries.map(([currency, value]) => formatMoney(value, currency)).join(' · ');
}

export function toTenantSummary(raw: unknown): PlatformTenantSummary {
  const d = rec(raw);
  const sub = rec(d.subscription);
  return {
    id: str(d.id),
    slug: str(d.slug),
    name: str(d.name),
    establishmentType: str(d.establishmentType),
    countryCode: str(d.countryCode),
    status: str(d.status),
    createdAt: str(d.createdAt),
    subscription: str(sub.status) === '' ? null : { status: str(sub.status), planCode: str(sub.planCode), currentPeriodEnd: str(sub.currentPeriodEnd) },
  };
}

export function toPlatformSubscription(raw: unknown): PlatformSubscriptionView | null {
  const base = toSubscription(raw);
  if (!base) return null;
  const d = rec(raw);
  return { ...base, tenantId: str(d.tenantId), trialExtended: bool(d.trialExtended), suspensionReason: strOrNull(d.suspensionReason) };
}

export function toTenantDetail(raw: unknown): PlatformTenantDetail {
  const d = rec(raw);
  const tenant = rec(d.tenant);
  const usage = rec(d.usage);
  const invoices = rec(d.invoices);
  return {
    tenant: {
      ...toTenantSummary(tenant),
      legalName: str(tenant.legalName),
      baseCurrency: str(tenant.baseCurrency, 'XOF'),
      timezone: str(tenant.timezone, 'UTC'),
      suspensionReason: strOrNull(tenant.suspensionReason),
    },
    subscription: toPlatformSubscription(d.subscription),
    usage: {
      users: num(usage.users),
      sites: num(usage.sites),
      patients: num(usage.patients),
      appointmentsThisMonth: num(usage.appointmentsThisMonth),
      appointmentsLast30Days: num(usage.appointmentsLast30Days),
    },
    modules: strings(d.modules),
    invoices: { open: num(invoices.open), overdue: num(invoices.overdue) },
  };
}

export function toPlatformPlan(raw: unknown): PlatformPlanView {
  const d = rec(raw);
  return { ...toPublicPlan(raw), isPublic: bool(d.isPublic), archivedAt: strOrNull(d.archivedAt), createdAt: str(d.createdAt), entitlements: toEntitlements(d.entitlements) };
}

export function toPlatformInvoice(raw: unknown): PlatformInvoiceView {
  const d = rec(raw);
  return { ...toSaasInvoice(raw), tenantId: str(d.tenantId), tenantSlug: str(d.tenantSlug) };
}

export function toManualPayment(raw: unknown): ManualPaymentView {
  const d = rec(raw);
  const method = str(d.method);
  const status = str(d.status);
  return {
    id: str(d.id),
    invoiceId: str(d.invoiceId),
    invoiceNumber: str(d.invoiceNumber),
    tenantId: str(d.tenantId),
    amount: amount(d.amount),
    currency: str(d.currency, 'XOF'),
    method: (MANUAL_PAYMENT_METHODS as readonly string[]).includes(method) ? (method as ManualPaymentView['method']) : 'other',
    reference: str(d.reference),
    receivedAt: str(d.receivedAt),
    status: status === 'validated' || status === 'rejected' ? status : 'pending',
    enteredBy: str(d.enteredBy),
    decidedBy: strOrNull(d.decidedBy),
    decidedAt: strOrNull(d.decidedAt),
    rejectionReason: strOrNull(d.rejectionReason),
    createdAt: str(d.createdAt),
  };
}

export const LIMIT_FIELDS = [
  ['users', 'Utilisateurs'],
  ['sites', 'Sites'],
  ['appointmentsMonthly', 'Rendez-vous par mois'],
  ['activePatients', 'Patients actifs'],
  ['smsMonthly', 'SMS par mois'],
  ['storageGb', 'Stockage (Go)'],
] as const;

export const FEATURE_FIELDS = [
  ['customRoles', 'Rôles personnalisés'],
  ['export', 'Exports'],
  ['api', 'API d\'intégration'],
] as const;

const WHOLE_NUMBER = /^\d{1,9}$/;
const MODULE_SEPARATORS = /[\s,;]+/;
const REQUIRED_MODULES = ['billing', 'cashier'] as const;

export type BuildResult<T> = { readonly ok: true; readonly body: T } | { readonly ok: false; readonly fieldErrors: Record<string, string> };

/** Formulaire « nouvelle version de plan » vers le corps de POST /platform/plans (champ de limite vide = illimité). */
export function buildPlanVersionInput(flat: Readonly<Record<string, string | undefined>>): BuildResult<CreatePlanVersionInput> {
  const fieldErrors: Record<string, string> = {};
  const limits: Record<string, number | null> = {};
  for (const [key] of LIMIT_FIELDS) {
    const raw = (flat[`limits.${key}`] ?? '').trim();
    if (raw === '') limits[key] = null;
    else if (WHOLE_NUMBER.test(raw)) limits[key] = Number(raw);
    else fieldErrors[`limits.${key}`] = 'Nombre entier positif, ou vide pour illimité.';
  }
  const prices: Record<string, string> = {};
  for (const key of ['priceMonthly', 'priceYearly'] as const) {
    const price = parseMoneyInput(flat[key] ?? '');
    if (price.ok) prices[key] = price.amount;
    else fieldErrors[key] = price.error;
  }
  const modules = [...new Set((flat.modules ?? '').split(MODULE_SEPARATORS).map((m) => m.trim().toLowerCase()).filter(Boolean))].sort();
  const missing = REQUIRED_MODULES.filter((required) => !modules.includes(required));
  if (missing.length > 0) fieldErrors.modules = `Les modules ${missing.join(' et ')} sont obligatoires dans tous les plans.`;

  const parsed = createPlanVersionSchema.safeParse({
    code: (flat.code ?? '').trim(),
    name: flat.name ?? '',
    tier: flat.tier,
    ...prices,
    currency: (flat.currency ?? '').trim().toUpperCase(),
    entitlements: {
      modules,
      limits,
      features: { customRoles: flat['features.customRoles'] === 'on', export: flat['features.export'] === 'on', api: flat['features.api'] === 'on' },
    },
    isPublic: flat.isPublic === 'on',
  });
  if (!parsed.success) Object.assign(fieldErrors, { ...fieldErrorsFromZod(parsed.error), ...fieldErrors });
  return Object.keys(fieldErrors).length > 0 || !parsed.success ? { ok: false, fieldErrors } : { ok: true, body: parsed.data };
}

/** Saisie d'un paiement manuel : la date de réception (jour) devient un instant ISO UTC. */
export function buildManualPaymentInput(flat: Readonly<Record<string, string | undefined>>): BuildResult<CreateManualPaymentInput> {
  const fieldErrors: Record<string, string> = {};
  const money = parseMoneyInput(flat.amount ?? '');
  if (!money.ok) fieldErrors.amount = money.error;
  const day = (flat.receivedAt ?? '').trim();
  if (!isDayString(day)) fieldErrors.receivedAt = 'Date de réception invalide.';
  const parsed = createManualPaymentSchema.safeParse({
    amount: money.ok ? money.amount : '',
    method: flat.method,
    reference: flat.reference ?? '',
    receivedAt: isDayString(day) ? `${day}T00:00:00.000Z` : '',
  });
  if (!parsed.success) Object.assign(fieldErrors, { ...fieldErrorsFromZod(parsed.error), ...fieldErrors });
  return Object.keys(fieldErrors).length > 0 || !parsed.success ? { ok: false, fieldErrors } : { ok: true, body: parsed.data };
}

