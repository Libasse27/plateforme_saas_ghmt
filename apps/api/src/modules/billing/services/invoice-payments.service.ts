import { Inject, Injectable } from '@nestjs/common';
import type { AbandonPaymentView, InvoicePaymentView, OnlinePaymentView, RecordPaymentInput } from '@ghmt/shared';
import { AuditService } from '../../../common/audit/audit.service';
import { RequestContext } from '../../../common/context/request-context';
import { DomainError } from '../../../common/errors/domain-error';
import { assertAmountScale } from '../../../common/money/currency-scale';
import { addMoney, formatMoney, parseMoney, subtractMoney, type Money } from '../../../common/money/money';
import { PAYMENTS_GATEWAY, PaymentProviderUnavailableError, type InitiatedPayment, type PaymentsGateway } from '../../../common/payments/payments-gateway';
import { Clock } from '../../../common/time/clock';
import type { PatientInvoice, PatientPayment } from '../../../generated/prisma/client';
import { TenantDb, type TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { statusAfterPayments } from '../domain/invoice-status';
import { toPaymentView } from '../mappers/billing.mapper';
import { CashierRepository } from '../repositories/cashier.repository';
import { InvoicesRepository } from '../repositories/invoices.repository';
import { refIssue } from './billing-errors';
import { RefreshThrottle } from './refresh-throttle';
import { SiteScopeService } from './site-scope.service';

const PAYABLE_STATUSES: readonly string[] = ['issued', 'partially_paid'];
const ONLINE_METHODS: readonly string[] = ['mobile_money', 'card'];
/** Modes rattachés à une session de caisse ouverte par l'encaisseur (espèces, chèque, virement). */
const CASH_SESSION_METHODS: readonly string[] = ['cash', 'other'];
export const PROVIDER_UNAVAILABLE_REASON = 'provider_unavailable';
const ABANDONED_REASON = 'abandoned';

type PaymentOutcome = InvoicePaymentView | OnlinePaymentView;

/** Encaissements d'une facture : espèces et autres modes (immédiats), Mobile Money / carte (via la passerelle de paiement). */
@Injectable()
export class InvoicePaymentsService {
  constructor(
    private readonly db: TenantDb,
    private readonly invoices: InvoicesRepository,
    private readonly cashier: CashierRepository,
    private readonly siteScopes: SiteScopeService,
    private readonly audit: AuditService,
    private readonly context: RequestContext,
    private readonly clock: Clock,
    private readonly refreshThrottle: RefreshThrottle,
    @Inject(PAYMENTS_GATEWAY) private readonly gateway: PaymentsGateway,
  ) {}

  record(invoiceId: string, input: RecordPaymentInput): Promise<PaymentOutcome> {
    return ONLINE_METHODS.includes(input.method) ? this.initiateOnline(invoiceId, input) : this.recordImmediate(invoiceId, input);
  }

  /** Reprise manuelle : re-vérifie la tentative auprès du fournisseur (webhook perdu) puis relit le paiement. Auditée. */
  async refresh(paymentId: string): Promise<InvoicePaymentView> {
    const { tenantId } = this.context.requirePrincipal();
    const attemptId = await this.requireOnlineAttempt(tenantId, paymentId);
    this.refreshThrottle.assertAllowed(paymentId);
    // Le règlement publie `payment.succeeded|failed` : le gestionnaire de ce module met le paiement à jour.
    await this.gateway.refresh(attemptId);
    return this.db.run(async (tx) => {
      const payment = await this.invoices.findPayment(tx, tenantId, paymentId);
      if (!payment) throw DomainError.notFound('Paiement');
      await this.audit.record(tx, tenantId, {
        action: 'payment.refreshed',
        resourceType: 'payment',
        resourceId: paymentId,
        patientId: payment.patientId,
        changes: { invoiceId: payment.invoiceId, status: payment.status },
      });
      return toPaymentView(payment);
    });
  }

  /**
   * Abandon par l'encaisseur (R4) : re-vérifie la tentative chez le fournisseur. S'il y a eu succès, le paiement est
   * enregistré ; sinon il passe à `cancelled`, le montant réservé est libéré et la tentative est abandonnée (un succès
   * confirmé plus tard reste enregistrable). Fournisseur injoignable ⇒ 502 : on ne libère pas un montant peut-être encaissé.
   */
  async abandon(paymentId: string): Promise<AbandonPaymentView> {
    const { tenantId } = this.context.requirePrincipal();
    const found = await this.db.run(async (tx) => {
      const payment = await this.findInScope(tx, tenantId, paymentId);
      return { status: payment.status, attemptId: payment.attemptId };
    });
    if (found.status === 'succeeded') return { status: 'succeeded' };
    if (found.status !== 'pending') return { status: 'cancelled' };
    if (found.attemptId) await this.gateway.refresh(found.attemptId);

    const outcome = await this.db.run((tx) => this.cancelIfStillPending(tx, tenantId, paymentId));
    if (outcome === 'cancelled' && found.attemptId) await this.gateway.cancel(found.attemptId);
    return { status: outcome };
  }

  /** Sous verrou de facture : annule le paiement s'il est toujours en attente, sinon renvoie son issue actuelle. */
  private async cancelIfStillPending(tx: TenantTx, tenantId: string, paymentId: string): Promise<AbandonPaymentView['status']> {
    const payment = await this.findInScope(tx, tenantId, paymentId);
    await this.invoices.lock(tx, tenantId, payment.invoiceId);
    const current = await this.invoices.findPayment(tx, tenantId, paymentId);
    if (!current) throw DomainError.notFound('Paiement');
    if (current.status === 'succeeded') return 'succeeded';
    if (current.status === 'pending') {
      await this.invoices.updatePendingPayment(tx, tenantId, paymentId, { status: 'cancelled', failureReason: ABANDONED_REASON });
      await this.audit.record(tx, tenantId, {
        action: 'payment.abandoned',
        resourceType: 'payment',
        resourceId: paymentId,
        patientId: current.patientId,
        changes: { invoiceId: current.invoiceId, method: current.method, amount: formatMoney(current.amount), attemptId: current.attemptId },
      });
    }
    return 'cancelled';
  }

  /** Identifiant de tentative d'un paiement en ligne de la portée de l'encaisseur, sinon 404. */
  private async requireOnlineAttempt(tenantId: string, paymentId: string): Promise<string> {
    const payment = await this.db.run((tx) => this.findInScope(tx, tenantId, paymentId));
    if (!payment.attemptId) throw DomainError.notFound('Paiement');
    return payment.attemptId;
  }

  private async findInScope(tx: TenantTx, tenantId: string, paymentId: string): Promise<PatientPayment> {
    const siteScope = await this.siteScopes.resolve(tx, tenantId, 'cashier:payment:create');
    const payment = await this.invoices.findPayment(tx, tenantId, paymentId);
    const invoice = payment ? await this.invoices.findDetail(tx, tenantId, payment.invoiceId) : null;
    if (!payment || !invoice || !siteScope.includes(invoice.siteId)) throw DomainError.notFound('Paiement');
    return payment;
  }

  private recordImmediate(invoiceId: string, input: RecordPaymentInput): Promise<InvoicePaymentView> {
    const { tenantId, userId } = this.context.requirePrincipal();
    return this.db.run(async (tx) => {
      const invoice = await this.lockPayable(tx, tenantId, invoiceId);
      const amount = await this.assertWithinBalance(tx, tenantId, invoice, input.amount);
      const cashSessionId = CASH_SESSION_METHODS.includes(input.method) ? await this.requireOwnOpenSession(tx, tenantId, userId, invoice, input.cashSessionId) : null;

      const now = this.clock.now();
      const payment = await this.invoices.createPayment(tx, {
        tenantId,
        invoiceId,
        patientId: invoice.patientId,
        method: input.method,
        amount,
        currency: invoice.currency,
        status: 'succeeded',
        paidAt: now,
        cashSessionId,
        receivedBy: userId,
        reference: input.reference ?? null,
      });
      const updated = await this.applyToInvoice(tx, tenantId, invoice, amount, userId);
      await this.audit.record(tx, tenantId, {
        action: 'payment.recorded',
        resourceType: 'payment',
        resourceId: payment.id,
        patientId: invoice.patientId,
        changes: {
          invoiceId,
          method: input.method,
          amount: formatMoney(amount),
          cashSessionId,
          invoiceStatus: updated.status,
        },
      });
      return toPaymentView(payment);
    });
  }

  private async initiateOnline(invoiceId: string, input: RecordPaymentInput): Promise<OnlinePaymentView> {
    const { tenantId, userId } = this.context.requirePrincipal();
    // Étape 1 (transaction) : réserver le montant par un paiement « pending » validé sous verrou de facture.
    const { payment, invoice } = await this.db.run(async (tx) => {
      const locked = await this.lockPayable(tx, tenantId, invoiceId);
      const pending = await this.invoices.pendingOnlineTotal(tx, tenantId, invoiceId);
      if (pending.count > 0) throw DomainError.conflict('payment_already_pending', 'Un paiement en ligne est déjà en attente pour cette facture.');
      const amount = await this.assertWithinBalance(tx, tenantId, locked, input.amount);
      const created = await this.invoices.createPayment(tx, {
        tenantId,
        invoiceId,
        patientId: locked.patientId,
        method: input.method,
        amount,
        currency: locked.currency,
        status: 'pending',
        receivedBy: userId,
      });
      await this.audit.record(tx, tenantId, {
        action: 'payment.initiated',
        resourceType: 'payment',
        resourceId: created.id,
        patientId: locked.patientId,
        changes: { invoiceId, method: input.method, amount: formatMoney(amount) },
      });
      return { payment: created, invoice: locked };
    });

    // Étape 2 (hors transaction) : appel de l'agrégateur ; le numéro de téléphone ne transite que vers la passerelle.
    let initiated: InitiatedPayment;
    try {
      initiated = await this.gateway.initiate({
        purpose: 'patient_invoice',
        tenantId,
        referenceId: invoiceId,
        amount: formatMoney(payment.amount),
        currency: payment.currency,
        channel: input.method as 'mobile_money' | 'card',
        payerPhone: input.payerPhone,
        description: `Facture ${invoice.number}`,
        idempotencyKey: `patient-payment:${payment.id}`,
      });
    } catch (error: unknown) {
      await this.handleInitiationFailure(tenantId, payment, error);
      throw error;
    }

    // Étape 3 : rattacher la tentative (si la confirmation est déjà arrivée, le paiement est déjà réglé : rien à faire).
    return this.db.run(async (tx) => {
      await this.invoices.updatePendingPayment(tx, tenantId, payment.id, {
        attemptId: initiated.attemptId,
        provider: initiated.provider,
        checkoutUrl: initiated.checkoutUrl,
      });
      const current = await this.invoices.findPayment(tx, tenantId, payment.id);
      if (!current) throw DomainError.notFound('Paiement');
      return { payment: toPaymentView(current), checkoutUrl: initiated.checkoutUrl, instructions: initiated.instructions };
    });
  }

  /**
   * Échec technique (la tentative reste `pending` chez la plateforme) : le paiement reste en attente, rattaché à sa tentative,
   * et le job de relance l'interroge. Refus explicite ou erreur inconnue : le paiement échoue et libère la réservation.
   */
  private async handleInitiationFailure(tenantId: string, payment: PatientPayment, error: unknown): Promise<void> {
    if (error instanceof PaymentProviderUnavailableError && error.attemptRetained && error.attemptId) {
      const attemptId = error.attemptId;
      await this.db.run((tx) => this.invoices.updatePendingPayment(tx, tenantId, payment.id, { attemptId }));
      return;
    }
    await this.db.run(async (tx) => {
      const updated = await this.invoices.updatePendingPayment(tx, tenantId, payment.id, { status: 'failed', failureReason: PROVIDER_UNAVAILABLE_REASON });
      if (!updated) return;
      await this.audit.record(tx, tenantId, {
        action: 'payment.failed',
        resourceType: 'payment',
        resourceId: payment.id,
        patientId: payment.patientId,
        outcome: 'failure',
        changes: { invoiceId: payment.invoiceId, method: payment.method, reason: PROVIDER_UNAVAILABLE_REASON },
      });
    });
  }

  /** Verrouille la facture et vérifie qu'elle est encaissable dans la portée de l'encaisseur. */
  private async lockPayable(tx: TenantTx, tenantId: string, invoiceId: string): Promise<PatientInvoice> {
    const siteScope = await this.siteScopes.resolve(tx, tenantId, 'cashier:payment:create');
    const invoice = await this.invoices.lock(tx, tenantId, invoiceId);
    if (!invoice || !siteScope.includes(invoice.siteId)) throw DomainError.notFound('Facture');
    if (!PAYABLE_STATUSES.includes(invoice.status)) {
      throw DomainError.conflict('invoice_not_payable', 'Cette facture n’est pas encaissable (brouillon, soldée ou annulée).');
    }
    return invoice;
  }

  /** Le montant ne peut dépasser le reste dû, déduction faite des paiements en ligne en attente (qui réservent leur montant). */
  private async assertWithinBalance(tx: TenantTx, tenantId: string, invoice: PatientInvoice, rawAmount: string): Promise<Money> {
    assertAmountScale(rawAmount, invoice.currency);
    const amount = parseMoney(rawAmount);
    const pending = await this.invoices.pendingOnlineTotal(tx, tenantId, invoice.id);
    const balance = subtractMoney(subtractMoney(invoice.total, invoice.amountPaid), pending.total);
    if (amount.greaterThan(balance)) {
      throw new DomainError('amount_exceeds_balance', 422, 'Unprocessable Entity', 'Le montant dépasse le reste dû de la facture.', {
        details: { balance: formatMoney(balance.isNegative() ? parseMoney('0') : balance) },
      });
    }
    return amount;
  }

  private async requireOwnOpenSession(tx: TenantTx, tenantId: string, userId: string, invoice: PatientInvoice, sessionId: string | undefined): Promise<string> {
    // Verrou partagé : la clôture (verrou exclusif) attend les encaissements en cours, et inversement.
    const session = sessionId ? await this.cashier.lockSession(tx, tenantId, sessionId, 'share') : null;
    if (!session || session.currency !== invoice.currency) throw refIssue('cashSessionId', 'Session de caisse introuvable pour cette devise.');
    if (session.openedBy !== userId) {
      throw DomainError.forbidden('cash_session_not_owned', 'Cette session de caisse a été ouverte par un autre utilisateur.', 'cashier:payment:create');
    }
    if (session.status !== 'open') throw DomainError.conflict('cash_session_not_open', 'Cette session de caisse n’est plus ouverte.');
    if (session.register.siteId !== invoice.siteId) {
      throw new DomainError('cash_register_site_mismatch', 422, 'Unprocessable Entity', 'La caisse de cette session n’est pas rattachée au site de la facture.', {
        errors: [{ path: 'cashSessionId', code: 'cash_register_site_mismatch', message: 'Caisse d’un autre site que la facture.' }],
      });
    }
    return session.id;
  }

  /** Cumule le paiement dans la facture et recalcule son statut (verrou de facture déjà détenu). */
  async applyToInvoice(tx: TenantTx, tenantId: string, invoice: PatientInvoice, amount: Money, userId?: string): Promise<PatientInvoice> {
    const amountPaid = addMoney(invoice.amountPaid, amount);
    return this.invoices.update(tx, tenantId, invoice.id, {
      amountPaid,
      status: invoice.status === 'void' ? 'void' : statusAfterPayments(invoice.total, amountPaid),
      ...(userId ? { updatedBy: userId } : {}),
    });
  }
}
