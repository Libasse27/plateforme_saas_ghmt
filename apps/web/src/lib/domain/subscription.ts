import {
  BILLING_PERIODS,
  PLAN_TIERS,
  SAAS_INVOICE_KINDS,
  SAAS_INVOICE_STATUSES,
  SUBSCRIPTION_STATUSES,
  type BillingPeriod,
  type ChangePlanResult,
  type Entitlements,
  type PayInvoiceView,
  type PlanSummary,
  type PlanTier,
  type PublicPlanView,
  type SaasInvoiceKind,
  type SaasInvoiceStatus,
  type SaasInvoiceView,
  type SubscriptionStatus,
  type SubscriptionView,
} from '@ghmt/shared';
import { daysUntil, formatDay } from '../format/dates';
import { formatMoney } from './money';
import { amount, bool, items, num, numOrNull, rec, str, strOrNull, strings } from './raw';

export const STATUS_LABELS: Readonly<Record<SubscriptionStatus, string>> = {
  trial: 'Essai gratuit',
  active: 'Actif',
  past_due: 'Paiement en retard',
  grace: 'Période de grâce',
  suspended: 'Suspendu',
  cancelled: 'Résilié',
  expired: 'Expiré',
};

export const PERIOD_LABELS: Readonly<Record<BillingPeriod, string>> = { monthly: 'Mensuel', yearly: 'Annuel' };

export const INVOICE_STATUS_LABELS: Readonly<Record<SaasInvoiceStatus, string>> = {
  draft: 'Brouillon',
  open: 'À payer',
  paid: 'Payée',
  void: 'Annulée',
  uncollectible: 'Irrécouvrable',
};

export const INVOICE_KIND_LABELS: Readonly<Record<SaasInvoiceKind, string>> = {
  renewal: 'Renouvellement',
  conversion: 'Conversion de l\'essai',
  upgrade_prorata: 'Montée en gamme (prorata)',
};

function oneOf<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function toPlanSummary(raw: unknown): PlanSummary {
  const data = rec(raw);
  return {
    id: str(data.id),
    code: str(data.code),
    version: num(data.version, 1),
    name: str(data.name, 'Plan'),
    tier: oneOf<PlanTier>(PLAN_TIERS, data.tier, 'basic'),
    priceMonthly: amount(data.priceMonthly),
    priceYearly: amount(data.priceYearly),
    currency: str(data.currency, 'XOF'),
  };
}

export function toEntitlements(raw: unknown): Entitlements {
  const data = rec(raw);
  const limits = rec(data.limits);
  const features = rec(data.features);
  return {
    modules: strings(data.modules),
    limits: {
      users: numOrNull(limits.users),
      sites: numOrNull(limits.sites),
      appointmentsMonthly: numOrNull(limits.appointmentsMonthly),
      activePatients: numOrNull(limits.activePatients),
      smsMonthly: numOrNull(limits.smsMonthly),
      storageGb: numOrNull(limits.storageGb),
    },
    features: { customRoles: bool(features.customRoles), export: bool(features.export), api: bool(features.api) },
  };
}

/** Offre publique ; `selectable` est false en essai pour les offres réservées (l'API reste l'autorité). */
export interface PlanOffer extends PublicPlanView {
  readonly selectable: boolean;
}

export function toPublicPlan(raw: unknown): PlanOffer {
  return { ...toPlanSummary(raw), entitlements: toEntitlements(rec(raw).entitlements), selectable: rec(raw).selectable !== false };
}

export function toSubscription(raw: unknown): SubscriptionView | null {
  const data = rec(raw);
  if (!(SUBSCRIPTION_STATUSES as readonly string[]).includes(str(data.status)) || str(data.id) === '') return null;
  const pending = rec(data.pendingChange);
  const usage = rec(data.usage);
  return {
    id: str(data.id),
    status: data.status as SubscriptionStatus,
    billingPeriod: oneOf<BillingPeriod>(BILLING_PERIODS, data.billingPeriod, 'monthly'),
    currentPeriodStart: str(data.currentPeriodStart),
    currentPeriodEnd: str(data.currentPeriodEnd),
    trialEndsAt: strOrNull(data.trialEndsAt),
    cancelAtPeriodEnd: bool(data.cancelAtPeriodEnd),
    plan: toPlanSummary(data.plan),
    pendingChange:
      str(pending.planCode) === ''
        ? null
        : {
            planCode: str(pending.planCode),
            billingPeriod: oneOf<BillingPeriod>(BILLING_PERIODS, pending.billingPeriod, 'monthly'),
            effectiveAt: str(pending.effectiveAt),
          },
    entitlements: toEntitlements(data.entitlements),
    usage: { users: num(usage.users), sites: num(usage.sites), appointmentsThisMonth: num(usage.appointmentsThisMonth) },
  };
}

export function toSaasInvoice(raw: unknown): SaasInvoiceView {
  const data = rec(raw);
  return {
    id: str(data.id),
    number: str(data.number),
    status: oneOf<SaasInvoiceStatus>(SAAS_INVOICE_STATUSES, data.status, 'open'),
    kind: oneOf<SaasInvoiceKind>(SAAS_INVOICE_KINDS, data.kind, 'renewal'),
    currency: str(data.currency, 'XOF'),
    subtotal: amount(data.subtotal),
    taxRate: str(data.taxRate, '0.0000'),
    taxAmount: amount(data.taxAmount),
    total: amount(data.total),
    periodStart: str(data.periodStart),
    periodEnd: str(data.periodEnd),
    issuedAt: str(data.issuedAt),
    dueAt: str(data.dueAt),
    paidAt: strOrNull(data.paidAt),
    lines: items(data.lines, (line) => {
      const l = rec(line);
      return { description: str(l.description), quantity: num(l.quantity, 1), unitPrice: amount(l.unitPrice), amount: amount(l.amount) };
    }),
  };
}

export function toPayCheckout(raw: unknown): PayInvoiceView {
  const data = rec(raw);
  return {
    attemptId: str(data.attemptId),
    status: str(data.status),
    provider: str(data.provider),
    checkoutUrl: strOrNull(data.checkoutUrl),
    instructions: strOrNull(data.instructions),
  };
}

export interface ChangePlanOutcome {
  readonly effect: ChangePlanResult['effect'];
  readonly subscription: SubscriptionView | null;
  readonly invoice: SaasInvoiceView | null;
}

const EFFECTS: readonly ChangePlanResult['effect'][] = ['immediate', 'scheduled', 'pending_payment'];

export function toChangePlanResult(raw: unknown): ChangePlanOutcome {
  const data = rec(raw);
  return {
    effect: oneOf(EFFECTS, data.effect, 'immediate'),
    subscription: toSubscription(data.subscription),
    invoice: Object.keys(rec(data.invoice)).length > 0 ? toSaasInvoice(data.invoice) : null,
  };
}

export interface Banner {
  readonly tone: 'info' | 'warning' | 'error';
  readonly message: string;
}

/** Bandeau global (toutes les pages) pour un abonnement qui restreint l'usage. */
export function subscriptionBanner(status: SubscriptionStatus): Banner | null {
  switch (status) {
    case 'past_due':
      return { tone: 'warning', message: 'Votre abonnement est en retard de paiement. Réglez la facture en cours pour éviter une restriction de votre accès.' };
    case 'grace':
      return {
        tone: 'warning',
        message: 'Votre abonnement est en période de grâce : la création et l\'invitation d\'utilisateurs ainsi que les exports sont bloqués jusqu\'au paiement.',
      };
    case 'suspended':
    case 'expired':
      return {
        tone: 'error',
        message: 'Votre abonnement est suspendu : la console est en lecture seule (la création de patients et l\'encaissement restent possibles). Réglez la facture pour la réactiver.',
      };
    default:
      return null;
  }
}

export const SUBSCRIPTION_MODES = ['normal', 'restricted', 'continuity'] as const;
export type SubscriptionMode = (typeof SUBSCRIPTION_MODES)[number];

/** Statut léger accessible à tout utilisateur authentifié (R1) : aucune donnée financière. */
export interface SubscriptionStatusView {
  readonly status: string;
  readonly trialEndsAt: string | null;
  readonly daysLeft: number | null;
  readonly mode: SubscriptionMode;
}

export function toSubscriptionStatus(raw: unknown): SubscriptionStatusView | null {
  const data = rec(raw);
  if (!(SUBSCRIPTION_MODES as readonly string[]).includes(str(data.mode))) return null;
  return { status: str(data.status), trialEndsAt: strOrNull(data.trialEndsAt), daysLeft: numOrNull(data.daysLeft), mode: data.mode as SubscriptionMode };
}

export const RESTRICTED_MESSAGE = 'Abonnement en retard de paiement : certaines actions administratives sont limitées.';
export const CONTINUITY_MESSAGE = 'Mode continuité des soins : consultation, création de patient, facturation et encaissement restent possibles.';

/** Bandeau du personnel (tous les utilisateurs) selon le mode de l'abonnement ; `null` si rien à signaler. */
export function statusBanner(view: SubscriptionStatusView): Banner | null {
  if (view.mode === 'restricted') return { tone: 'warning', message: RESTRICTED_MESSAGE };
  if (view.mode === 'continuity') return { tone: 'error', message: CONTINUITY_MESSAGE };
  if (view.status === 'trial' && view.daysLeft !== null && view.daysLeft >= 0) return { tone: 'info', message: `Période d'essai — J-${String(view.daysLeft)}` };
  return null;
}

/** Phrase de synthèse de l'état de l'abonnement (page /abonnement). */
export function subscriptionHeadline(sub: SubscriptionView, now: Date, timeZone: string): string {
  const end = formatDay(sub.currentPeriodEnd, timeZone);
  switch (sub.status) {
    case 'trial': {
      const left = daysUntil(sub.trialEndsAt ?? sub.currentPeriodEnd, now);
      const until = formatDay(sub.trialEndsAt ?? sub.currentPeriodEnd, timeZone);
      return left === null || left === 0 ? 'Votre essai gratuit se termine aujourd\'hui.' : `Essai gratuit : J-${String(left)} (jusqu'au ${until}).`;
    }
    case 'active':
      return sub.cancelAtPeriodEnd
        ? `Résiliation programmée : l'abonnement prendra fin le ${end}. Vous pouvez le reprendre.`
        : `Abonnement actif, renouvelé le ${end}.`;
    case 'past_due':
      return `Paiement en retard : la période s'est terminée le ${end}.`;
    case 'grace':
      return 'Période de grâce : réglez la facture en retard pour éviter la suspension.';
    case 'suspended':
      return 'Abonnement suspendu : la console est en lecture seule.';
    case 'cancelled':
      return 'Abonnement résilié. Choisissez un plan pour le réactiver.';
    default:
      return 'Abonnement expiré. Choisissez un plan pour le réactiver.';
  }
}

export interface UsageRow {
  readonly key: 'users' | 'sites' | 'appointments';
  readonly label: string;
  readonly used: number;
  readonly limit: number | null;
  readonly over: boolean;
  readonly atLimit: boolean;
}

function usageRow(key: UsageRow['key'], label: string, used: number, limit: number | null): UsageRow {
  return { key, label, used, limit, over: limit !== null && used > limit, atLimit: limit !== null && used >= limit };
}

export function usageRows(sub: SubscriptionView): UsageRow[] {
  const { limits } = sub.entitlements;
  return [
    usageRow('users', 'Utilisateurs', sub.usage.users, limits.users),
    usageRow('sites', 'Sites', sub.usage.sites, limits.sites),
    usageRow('appointments', 'Rendez-vous du mois', sub.usage.appointmentsThisMonth, limits.appointmentsMonthly),
  ];
}

export function changeResultMessage(result: ChangePlanOutcome, timeZone: string): string {
  const invoice = result.invoice ? ` (${result.invoice.number}, ${formatMoney(result.invoice.total, result.invoice.currency)})` : '';
  if (result.effect === 'scheduled') {
    const at = result.subscription?.pendingChange?.effectiveAt;
    return at ? `Changement programmé : il prendra effet le ${formatDay(at, timeZone)}, à la fin de la période en cours.` : 'Changement programmé : il prendra effet à la fin de la période en cours.';
  }
  if (result.effect === 'pending_payment') {
    return `Le nouveau plan sera activé dès le paiement de la facture${invoice}.`;
  }
  return result.invoice
    ? `Votre plan a été modifié immédiatement. Une facture a été émise${invoice} : réglez-la depuis la liste ci-dessous.`
    : 'Votre plan a été modifié immédiatement.';
}

export function canPaySaasInvoice(status: SaasInvoiceStatus): boolean {
  return status === 'open';
}

const SANDBOX_CHECKOUT_PREFIX = '/sandbox/paiement/';

/**
 * URL vers laquelle rediriger après une demande de paiement : https (ou http hors production), jamais
 * un autre schéma. La page sandbox de développement reçoit le chemin de retour (déjà interne).
 */
export function checkoutRedirectTarget(checkoutUrl: string | null | undefined, returnPath: string, production: boolean): string | null {
  if (!checkoutUrl) return null;
  let url: URL;
  try {
    url = new URL(checkoutUrl);
  } catch {
    return null;
  }
  const allowed = url.protocol === 'https:' || (url.protocol === 'http:' && !production);
  if (!allowed) return null;
  if (url.pathname.startsWith(SANDBOX_CHECKOUT_PREFIX)) url.searchParams.set('retour', returnPath);
  return url.toString();
}

export type StatusTone = 'success' | 'info' | 'warning' | 'danger' | 'neutral';

const STATUS_TONES: Readonly<Record<SubscriptionStatus, StatusTone>> = {
  trial: 'info',
  active: 'success',
  past_due: 'warning',
  grace: 'warning',
  suspended: 'danger',
  cancelled: 'neutral',
  expired: 'danger',
};

export function statusTone(status: SubscriptionStatus): StatusTone {
  return STATUS_TONES[status];
}
