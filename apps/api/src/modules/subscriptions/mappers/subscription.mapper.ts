import type { PendingPlanChange, PlanSummary, SaasInvoiceView, SubscriptionUsage, SubscriptionView } from '@ghmt/shared';
import type { Plan, SaasInvoice, SaasInvoiceLine } from '../../../generated/prisma/client';
import type { TenantEntitlements } from '../../../common/authz/entitlement.service';

export type SaasInvoiceWithLines = SaasInvoice & { readonly lines: readonly SaasInvoiceLine[] };

function pendingChangeOf(entitlements: TenantEntitlements): PendingPlanChange | null {
  const { subscription } = entitlements;
  if (!subscription.pendingPlanCode && !subscription.pendingBillingPeriod) return null;
  return {
    planCode: subscription.pendingPlanCode ?? entitlements.plan.code,
    billingPeriod: subscription.pendingBillingPeriod ?? subscription.billingPeriod,
    effectiveAt: subscription.currentPeriodEnd.toISOString(),
  };
}

export function toSubscriptionView(entitlements: TenantEntitlements, usage: SubscriptionUsage): SubscriptionView {
  const { subscription, plan } = entitlements;
  return {
    id: subscription.id,
    status: subscription.status,
    billingPeriod: subscription.billingPeriod,
    currentPeriodStart: subscription.currentPeriodStart.toISOString(),
    currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
    trialEndsAt: subscription.trialEndsAt?.toISOString() ?? null,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    plan: {
      id: plan.id,
      code: plan.code,
      version: plan.version,
      name: plan.name,
      tier: plan.tier,
      priceMonthly: plan.priceMonthly,
      priceYearly: plan.priceYearly,
      currency: plan.currency,
    },
    pendingChange: pendingChangeOf(entitlements),
    entitlements: entitlements.entitlements,
    usage,
  };
}

export function toSaasInvoiceView(invoice: SaasInvoiceWithLines): SaasInvoiceView {
  return {
    id: invoice.id,
    number: invoice.number,
    status: invoice.status,
    kind: invoice.kind,
    currency: invoice.currency.trim(),
    subtotal: invoice.subtotal.toFixed(2),
    taxRate: invoice.taxRate.toFixed(4),
    taxAmount: invoice.taxAmount.toFixed(2),
    total: invoice.total.toFixed(2),
    periodStart: invoice.periodStart.toISOString(),
    periodEnd: invoice.periodEnd.toISOString(),
    issuedAt: invoice.issuedAt.toISOString(),
    dueAt: invoice.dueAt.toISOString(),
    paidAt: invoice.paidAt?.toISOString() ?? null,
    lines: [...invoice.lines]
      .sort((a, b) => a.position - b.position)
      .map((line) => ({ description: line.description, quantity: line.quantity, unitPrice: line.unitPrice.toFixed(2), amount: line.amount.toFixed(2) })),
  };
}

export function toPlanSummary(plan: Plan): PlanSummary {
  return {
    id: plan.id,
    code: plan.code,
    version: plan.version,
    name: plan.name,
    tier: plan.tier,
    priceMonthly: plan.priceMonthly.toFixed(2),
    priceYearly: plan.priceYearly.toFixed(2),
    currency: plan.currency.trim(),
  };
}
