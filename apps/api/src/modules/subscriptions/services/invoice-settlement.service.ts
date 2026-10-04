import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { PlatformAuditService, type PlatformActor } from '../../../common/audit/platform-audit.service';
import { DomainError } from '../../../common/errors/domain-error';
import { DomainEventBus } from '../../../common/events/domain-event-bus';
import type { PaymentSettledPayload } from '../../../common/events/domain-events';
import type { SaasInvoice } from '../../../generated/prisma/client';
import { PlatformDb, type PlatformTx } from '../../../infrastructure/prisma/platform-db.service';
import { addBillingPeriod } from '../domain/period';
import { SubscriptionsRepository } from '../repositories/subscriptions.repository';
import { SubscriptionStateService, type StatusChange } from './subscription-state.service';
import { TenantModulesSync } from './tenant-modules-sync';

export interface SettlementResult {
  readonly invoice: SaasInvoice;
  /** Faux si la facture était déjà payée (rejeu idempotent). */
  readonly applied: boolean;
}

/** Statuts pour lesquels la nouvelle période repart de « maintenant » (réactivation) plutôt que de l'ancienne échéance. */
const REACTIVATION_STATUSES = new Set(['suspended', 'expired', 'cancelled']);

/**
 * Règlement des factures SaaS (docs/09 §A4) : `payment.succeeded` (purpose `saas_invoice`) et paiements manuels validés
 * aboutissent ici. Facture `paid` ⇒ abonnement `active` avec nouvelle période = ancienne fin + durée. Idempotent : le verrou de
 * ligne sur la facture sérialise les rejeux et une facture déjà payée n'est jamais appliquée deux fois.
 */
@Injectable()
export class InvoiceSettlementService implements OnModuleInit {
  private readonly logger = new Logger(InvoiceSettlementService.name);

  constructor(
    private readonly platformDb: PlatformDb,
    private readonly repository: SubscriptionsRepository,
    private readonly state: SubscriptionStateService,
    private readonly modules: TenantModulesSync,
    private readonly audit: PlatformAuditService,
    private readonly events: DomainEventBus,
  ) {}

  onModuleInit(): void {
    this.events.subscribe('payment.succeeded', (payload) => this.onPaymentSucceeded(payload));
  }

  /** Abonné à `payment.succeeded` : ignore les autres finalités et toute charge utile incohérente avec la facture. */
  async onPaymentSucceeded(payload: PaymentSettledPayload): Promise<void> {
    if (payload.purpose !== 'saas_invoice') return;
    const outcome = await this.platformDb.run(async (tx) => {
      const invoice = await tx.saasInvoice.findUnique({ where: { id: payload.referenceId } });
      if (!invoice) return 'unknown' as const;
      const consistent =
        invoice.tenantId === payload.tenantId && invoice.total.toFixed(2) === payload.amount && invoice.currency.trim() === payload.currency;
      if (!consistent) {
        await this.audit.record(tx, {
          action: 'saas_invoice.payment_mismatch',
          actor: { type: 'system' },
          resourceType: 'saas_invoice',
          resourceId: invoice.id,
          tenantId: invoice.tenantId,
          outcome: 'denied',
          changes: { attemptId: payload.attemptId, provider: payload.provider },
        });
        return 'mismatch' as const;
      }
      if (invoice.status === 'void' || invoice.status === 'draft') {
        // Paiement reçu pour une facture annulée : jamais perdu en silence ni rejoué en boucle — rapprochement manuel.
        await this.audit.record(tx, {
          action: 'saas_invoice.payment_on_unpayable_invoice',
          actor: { type: 'system' },
          resourceType: 'saas_invoice',
          resourceId: invoice.id,
          tenantId: invoice.tenantId,
          outcome: 'denied',
          changes: { attemptId: payload.attemptId, provider: payload.provider, invoiceStatus: invoice.status },
        });
        return 'unpayable' as const;
      }
      return 'ok' as const;
    });
    if (outcome === 'unknown') {
      this.logger.warn({ referenceId: payload.referenceId }, 'Paiement SaaS pour une facture inconnue : ignoré');
      return;
    }
    if (outcome === 'mismatch' || outcome === 'unpayable') {
      this.logger.warn({ referenceId: payload.referenceId, outcome }, 'Paiement SaaS non appliqué : rapprochement manuel requis');
      return;
    }
    await this.settle(payload.referenceId, {
      paidAt: new Date(payload.settledAt),
      channel: payload.provider,
      actor: { type: 'system' },
      reference: payload.attemptId,
    });
  }

  /** Règle une facture dans sa propre transaction puis publie les changements d'état. */
  async settle(invoiceId: string, meta: { paidAt: Date; channel: string; actor: PlatformActor; reference: string }): Promise<SettlementResult> {
    const result = await this.platformDb.run((tx) => this.settleInTx(tx, invoiceId, meta));
    await this.state.publish(result.changes);
    return { invoice: result.invoice, applied: result.applied };
  }

  /** Variante transactionnelle (paiement manuel validé : même transaction que la décision). Publication à la charge de l'appelant. */
  async settleInTx(
    tx: PlatformTx,
    invoiceId: string,
    meta: { paidAt: Date; channel: string; actor: PlatformActor; reference: string },
  ): Promise<SettlementResult & { changes: StatusChange[] }> {
    await tx.$queryRaw`SELECT id FROM platform.saas_invoices WHERE id = ${invoiceId}::uuid FOR UPDATE`;
    const invoice = await tx.saasInvoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) throw DomainError.notFound('Facture');
    if (invoice.status === 'paid') return { invoice, applied: false, changes: [] };
    if (invoice.status === 'void' || invoice.status === 'draft') {
      throw DomainError.conflict('invoice_not_payable', 'Cette facture ne peut pas être réglée.');
    }

    const paid = await tx.saasInvoice.update({ where: { id: invoice.id }, data: { status: 'paid', paidAt: meta.paidAt, paymentChannel: meta.channel } });
    await this.audit.record(tx, {
      action: 'saas_invoice.paid',
      actor: meta.actor,
      resourceType: 'saas_invoice',
      resourceId: invoice.id,
      tenantId: invoice.tenantId,
      changes: { number: invoice.number, channel: meta.channel, reference: meta.reference, total: invoice.total.toFixed(2) },
    });

    // Les factures de prorata ne renouvellent rien : le plan est déjà appliqué à l'émission.
    if (invoice.kind === 'upgrade_prorata') return { invoice: paid, applied: true, changes: [] };
    const change = await this.activate(tx, paid, meta);
    return { invoice: paid, applied: true, changes: change ? [change] : [] };
  }

  /** Renouvelle/réactive l'abonnement : nouvelle période, plan éventuellement planifié, droits et modules synchronisés. */
  private async activate(tx: PlatformTx, invoice: SaasInvoice, meta: { paidAt: Date; actor: PlatformActor }): Promise<StatusChange | null> {
    const subscription = await this.repository.lockById(tx, invoice.subscriptionId);
    if (!subscription) throw DomainError.notFound('Abonnement');

    const reactivation = REACTIVATION_STATUSES.has(subscription.status);
    const periodStart = reactivation ? meta.paidAt : invoice.periodStart;
    const periodEnd = reactivation ? addBillingPeriod(periodStart, invoice.billingPeriod) : invoice.periodEnd;
    // Le plan facturé s'applique s'il est planifié (changement à l'échéance) ; une facture périmée ne rétrograde jamais.
    const applyInvoicedPlan = subscription.pendingPlanId === invoice.planId;
    const planId = applyInvoicedPlan ? invoice.planId : subscription.planId;

    const change = await this.state.transition(tx, subscription, 'active', {
      actor: meta.actor,
      reason: 'invoice_paid',
      now: meta.paidAt,
      patch: {
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        billingPeriod: invoice.billingPeriod,
        planId,
        pendingPlanId: null,
        pendingBillingPeriod: null,
        cancelAtPeriodEnd: false,
      },
    });
    const refreshed = await tx.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    const plan = await this.repository.findPlan(tx, refreshed.planId);
    if (plan) await this.modules.sync(tx, refreshed.tenantId, plan, refreshed, meta.paidAt);
    return change;
  }
}
