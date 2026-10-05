import { Injectable } from '@nestjs/common';
import type { BillingPeriod, SaasInvoiceKind } from '@ghmt/shared';
import { PlatformAuditService, type PlatformActor } from '../../../common/audit/platform-audit.service';
import { DomainError } from '../../../common/errors/domain-error';
import type { Plan, SaasInvoice, Subscription } from '../../../generated/prisma/client';
import type { PlatformTx } from '../../../infrastructure/prisma/platform-db.service';
import { addDays } from '../domain/period';
import {
  INVOICE_DUE_DAYS,
  buildInvoiceDraft,
  buildProrataDraft,
  invoiceCurrency,
  type InvoiceDraft,
  type PlanPrice,
} from '../domain/pricing';
import { SubscriptionsRepository } from '../repositories/subscriptions.repository';

export function toPlanPrice(plan: Plan): PlanPrice {
  return {
    code: plan.code,
    name: plan.name,
    priceMonthly: plan.priceMonthly.toFixed(2),
    priceYearly: plan.priceYearly.toFixed(2),
    currency: plan.currency.trim(),
  };
}

interface IssueContext {
  readonly subscription: Subscription;
  readonly kind: SaasInvoiceKind;
  readonly planId: string;
  readonly billingPeriod: BillingPeriod;
  readonly countryCode: string;
  readonly dueAt: Date;
  readonly now: Date;
  readonly actor: PlatformActor;
}

/**
 * Émission des factures SaaS (docs/09 §A4). Le numéro `GHMT-{PAYS}-{AAAA}-{000001}` est attribué par un compteur verrouillé
 * dans la même transaction que l'insertion : aucun trou, même sous concurrence ou après annulation de la transaction.
 * L'appelant verrouille l'abonnement (FOR UPDATE) : deux exécutions concurrentes du job ne produisent qu'une facture.
 */
@Injectable()
export class InvoiceIssuerService {
  constructor(
    private readonly repository: SubscriptionsRepository,
    private readonly audit: PlatformAuditService,
  ) {}

  /** Facture de renouvellement ou de conversion pour la période débutant à `periodStart` ; `null` si elle existe déjà. */
  async issueRecurring(
    tx: PlatformTx,
    input: { subscription: Subscription; plan: Plan; billingPeriod: BillingPeriod; kind: 'renewal' | 'conversion'; periodStart: Date; now: Date; actor: PlatformActor },
  ): Promise<SaasInvoice | null> {
    const existing = await tx.saasInvoice.findFirst({
      where: { subscriptionId: input.subscription.id, kind: input.kind, periodStart: input.periodStart, status: { not: 'void' } },
      select: { id: true },
    });
    if (existing) return null;

    const tenant = await this.requireTenant(tx, input.subscription.tenantId);
    const entity = await this.repository.billingEntityFor(tx, tenant.countryCode);
    const draft = buildInvoiceDraft({
      plan: toPlanPrice(input.plan),
      billingPeriod: input.billingPeriod,
      taxRate: entity.taxRate,
      periodStart: input.periodStart,
      currency: invoiceCurrency(input.plan.currency.trim(), tenant.baseCurrency),
    });
    const dueAt = input.periodStart > input.now ? input.periodStart : addDays(input.now, INVOICE_DUE_DAYS);
    return this.persist(tx, draft, {
      subscription: input.subscription,
      kind: input.kind,
      planId: input.plan.id,
      billingPeriod: input.billingPeriod,
      countryCode: entity.countryCode,
      dueAt,
      now: input.now,
      actor: input.actor,
    });
  }

  /** Facture de prorata d'une montée en gamme ; `null` si le montant est nul. */
  async issueProrata(
    tx: PlatformTx,
    input: { subscription: Subscription; from: Plan; to: Plan; now: Date; actor: PlatformActor },
  ): Promise<SaasInvoice | null> {
    const tenant = await this.requireTenant(tx, input.subscription.tenantId);
    const entity = await this.repository.billingEntityFor(tx, tenant.countryCode);
    const draft = buildProrataDraft({
      from: toPlanPrice(input.from),
      to: toPlanPrice(input.to),
      billingPeriod: input.subscription.billingPeriod,
      taxRate: entity.taxRate,
      now: input.now,
      periodStart: input.subscription.currentPeriodStart,
      periodEnd: input.subscription.currentPeriodEnd,
      currency: invoiceCurrency(input.to.currency.trim(), tenant.baseCurrency),
    });
    if (!draft) return null;
    return this.persist(tx, draft, {
      subscription: input.subscription,
      kind: 'upgrade_prorata',
      planId: input.to.id,
      billingPeriod: input.subscription.billingPeriod,
      countryCode: entity.countryCode,
      dueAt: addDays(input.now, INVOICE_DUE_DAYS),
      now: input.now,
      actor: input.actor,
    });
  }

  /** Annule les factures de renouvellement/conversion encore ouvertes (elles seront réémises au nouveau tarif). */
  voidOpenRecurring(tx: PlatformTx, subscription: Subscription, now: Date, actor: PlatformActor, reason: string): Promise<number> {
    return this.voidOpen(tx, subscription, now, actor, reason, ['renewal', 'conversion']);
  }

  /** Annule les prorata de montée en gamme encore ouverts (une nouvelle demande remplace la précédente). */
  voidOpenProrata(tx: PlatformTx, subscription: Subscription, now: Date, actor: PlatformActor, reason: string): Promise<number> {
    return this.voidOpen(tx, subscription, now, actor, reason, ['upgrade_prorata']);
  }

  private async voidOpen(tx: PlatformTx, subscription: Subscription, now: Date, actor: PlatformActor, reason: string, kinds: readonly SaasInvoiceKind[]): Promise<number> {
    const open = await tx.saasInvoice.findMany({
      where: { subscriptionId: subscription.id, status: 'open', kind: { in: [...kinds] } },
      select: { id: true, number: true },
    });
    for (const invoice of open) {
      await tx.saasInvoice.update({ where: { id: invoice.id }, data: { status: 'void', voidedAt: now } });
      await this.audit.record(tx, {
        action: 'saas_invoice.voided',
        actor,
        resourceType: 'saas_invoice',
        resourceId: invoice.id,
        tenantId: subscription.tenantId,
        changes: { number: invoice.number, reason },
      });
    }
    return open.length;
  }

  private async persist(tx: PlatformTx, draft: InvoiceDraft, ctx: IssueContext): Promise<SaasInvoice> {
    const [{ number }] = await tx.$queryRaw<{ number: string }[]>`
      SELECT platform.next_saas_invoice_number(${ctx.countryCode}::char(2), ${ctx.now.getUTCFullYear()}::int) AS number`;
    // Brouillon puis passage en « open » : les lignes ne sont modifiables que sur un brouillon (trigger d'immutabilité).
    const created = await tx.saasInvoice.create({
      data: {
        number,
        tenantId: ctx.subscription.tenantId,
        subscriptionId: ctx.subscription.id,
        planId: ctx.planId,
        countryCode: ctx.countryCode,
        status: 'draft',
        kind: ctx.kind,
        billingPeriod: ctx.billingPeriod,
        currency: draft.currency,
        subtotal: draft.subtotal,
        taxRate: draft.taxRate,
        taxAmount: draft.taxAmount,
        total: draft.total,
        periodStart: draft.periodStart,
        periodEnd: draft.periodEnd,
        issuedAt: ctx.now,
        dueAt: ctx.dueAt,
        lines: { create: draft.lines.map((line) => ({ ...line })) },
      },
    });
    const issued = await tx.saasInvoice.update({ where: { id: created.id }, data: { status: 'open' } });
    await this.audit.record(tx, {
      action: 'saas_invoice.issued',
      actor: ctx.actor,
      resourceType: 'saas_invoice',
      resourceId: issued.id,
      tenantId: ctx.subscription.tenantId,
      changes: { number, kind: ctx.kind, total: draft.total, currency: draft.currency },
    });
    return issued;
  }

  private async requireTenant(tx: PlatformTx, tenantId: string) {
    const tenant = await this.repository.tenantBillingInfo(tx, tenantId);
    if (!tenant) throw DomainError.notFound('Établissement');
    return tenant;
  }
}
