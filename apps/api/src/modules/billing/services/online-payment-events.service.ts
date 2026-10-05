import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AuditService } from '../../../common/audit/audit.service';
import { DomainEventBus } from '../../../common/events/domain-event-bus';
import type { PaymentSettledPayload } from '../../../common/events/domain-events';
import { formatMoney, moneyEquals, parseMoney } from '../../../common/money/money';
import type { PatientPayment } from '../../../generated/prisma/client';
import { TenantDb, type TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { InvoicesRepository } from '../repositories/invoices.repository';
import { InvoicePaymentsService } from './invoice-payments.service';

const AMOUNT_MISMATCH_REASON = 'amount_mismatch';

/**
 * Réaction du module billing aux événements de la passerelle (purpose `patient_invoice`) : le paiement en attente est
 * réglé et le statut de la facture recalculé, dans le tenant de l'événement. Gestionnaires idempotents (rejeu par le job de relance).
 */
@Injectable()
export class OnlinePaymentEventsService implements OnModuleInit {
  private readonly logger = new Logger(OnlinePaymentEventsService.name);

  constructor(
    private readonly bus: DomainEventBus,
    private readonly db: TenantDb,
    private readonly invoices: InvoicesRepository,
    private readonly payments: InvoicePaymentsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe('payment.succeeded', (payload) => this.onSucceeded(payload));
    this.bus.subscribe('payment.failed', (payload) => this.onFailed(payload));
  }

  async onSucceeded(event: PaymentSettledPayload): Promise<void> {
    if (event.purpose !== 'patient_invoice') return;
    await this.db.runAs(event.tenantId, async (tx) => {
      const invoice = await this.invoices.lock(tx, event.tenantId, event.referenceId);
      const payment = invoice ? await this.settleablePaymentOf(tx, event) : null;
      if (!invoice || !payment) return this.logIgnored(event);

      if (payment.currency !== event.currency || !moneyEquals(payment.amount, parseMoney(event.amount))) {
        // Un paiement déjà échoué ou abandonné n'est pas rouvert pour un montant différent (rapprochement côté plateforme).
        if (payment.status !== 'pending') return this.logIgnored(event);
        await this.invoices.updatePendingPayment(tx, event.tenantId, payment.id, { status: 'failed', failureReason: AMOUNT_MISMATCH_REASON, attemptId: event.attemptId });
        await this.record(tx, event, payment, 'payment.failed', { invoiceId: invoice.id, reason: AMOUNT_MISMATCH_REASON });
        return;
      }
      // Un succès confirmé par le fournisseur est TOUJOURS enregistré, même tardif ; au-delà du reste dû (ou sur une facture
      // annulée), le paiement est marqué en anomalie et audité (remboursement : roadmap).
      const voided = invoice.status === 'void';
      const overpaid = voided || invoice.amountPaid.add(payment.amount).greaterThan(invoice.total);
      await this.invoices.settleOnlinePayment(tx, event.tenantId, payment.id, {
        status: 'succeeded',
        paidAt: new Date(event.settledAt),
        attemptId: event.attemptId,
        provider: event.provider,
        providerReference: event.providerReference,
        failureReason: null,
        ...(overpaid ? { anomaly: 'overpaid' } : {}),
      });
      const updated = voided ? invoice : await this.payments.applyToInvoice(tx, event.tenantId, invoice, payment.amount);
      await this.record(tx, event, payment, 'payment.succeeded', {
        invoiceId: invoice.id,
        method: payment.method,
        amount: formatMoney(payment.amount),
        invoiceStatus: updated.status,
        ...(payment.status !== 'pending' ? { late: true } : {}),
        ...(overpaid ? { anomaly: 'overpaid' } : {}),
      });
    });
  }

  async onFailed(event: PaymentSettledPayload & { readonly reason: string }): Promise<void> {
    if (event.purpose !== 'patient_invoice') return;
    await this.db.runAs(event.tenantId, async (tx) => {
      const invoice = await this.invoices.lock(tx, event.tenantId, event.referenceId);
      const payment = invoice ? await this.pendingPaymentOf(tx, event) : null;
      if (!invoice || !payment) return this.logIgnored(event);
      await this.invoices.updatePendingPayment(tx, event.tenantId, payment.id, { status: 'failed', failureReason: event.reason, attemptId: event.attemptId });
      await this.record(tx, event, payment, 'payment.failed', { invoiceId: invoice.id, method: payment.method, reason: event.reason });
    });
  }

  /** Paiement encore en attente de cette tentative ; à défaut, celui dont la tentative n'a pas encore été rattachée. */
  private async pendingPaymentOf(tx: TenantTx, event: PaymentSettledPayload): Promise<PatientPayment | null> {
    const attached = await this.invoices.findPaymentByAttempt(tx, event.tenantId, event.attemptId);
    if (attached) return attached.status === 'pending' ? attached : null;
    return this.invoices.findUnattachedPending(tx, event.tenantId, event.referenceId);
  }

  /** Comme `pendingPaymentOf`, mais accepte aussi un paiement échoué ou abandonné de cette tentative (succès tardif). */
  private async settleablePaymentOf(tx: TenantTx, event: PaymentSettledPayload): Promise<PatientPayment | null> {
    const attached = await this.invoices.findPaymentByAttempt(tx, event.tenantId, event.attemptId);
    if (attached) return attached.status === 'succeeded' ? null : attached;
    return this.invoices.findUnattachedPending(tx, event.tenantId, event.referenceId);
  }

  private record(tx: TenantTx, event: PaymentSettledPayload, payment: PatientPayment, action: string, changes: Record<string, unknown>): Promise<void> {
    return this.audit.record(tx, event.tenantId, {
      action,
      actorType: 'system',
      resourceType: 'payment',
      resourceId: payment.id,
      patientId: payment.patientId,
      changes: { ...changes, provider: event.provider },
    });
  }

  private logIgnored(event: PaymentSettledPayload): void {
    this.logger.warn({ attemptId: event.attemptId }, 'Événement de paiement sans paiement en attente correspondant : ignoré');
  }
}
