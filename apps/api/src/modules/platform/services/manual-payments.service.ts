import { Injectable } from '@nestjs/common';
import type { CreateManualPaymentInput, ListManualPaymentsQuery, ManualPaymentView, RejectManualPaymentInput } from '@ghmt/shared';
import { PlatformAuditService } from '../../../common/audit/platform-audit.service';
import { DomainError } from '../../../common/errors/domain-error';
import { Page, decodeUuidCursor } from '../../../common/pagination/page';
import { Clock } from '../../../common/time/clock';
import { Prisma, type ManualPayment } from '../../../generated/prisma/client';
import { PlatformDb, type PlatformTx } from '../../../infrastructure/prisma/platform-db.service';
import { InvoiceSettlementService } from '../../subscriptions/services/invoice-settlement.service';
import { SubscriptionStateService } from '../../subscriptions/services/subscription-state.service';
import type { PlatformPrincipal } from '../auth/platform-auth.guard';
import { actorOf } from './platform-actor';

/** Une facture n'accepte un paiement manuel que tant qu'elle est due. */
const PAYABLE_STATUSES = ['open', 'uncollectible'] as const;

function toView(payment: ManualPayment, invoiceNumber: string): ManualPaymentView {
  return {
    id: payment.id,
    invoiceId: payment.invoiceId,
    invoiceNumber,
    tenantId: payment.tenantId,
    amount: payment.amount.toFixed(2),
    currency: payment.currency.trim(),
    method: payment.method,
    reference: payment.reference,
    receivedAt: payment.receivedAt.toISOString(),
    status: payment.status,
    enteredBy: payment.enteredBy,
    decidedBy: payment.validatedBy,
    decidedAt: payment.decidedAt?.toISOString() ?? null,
    rejectionReason: payment.rejectionReason,
    createdAt: payment.createdAt.toISOString(),
  };
}

/**
 * Paiements manuels (virement, espèces revendeur) avec règle des quatre yeux (docs/09 §A4) : la saisie et la validation
 * relèvent de deux utilisateurs plateforme différents (refus 403 `four_eyes_required`, garanti aussi par une contrainte SQL).
 * La validation règle la facture et active l'abonnement dans la même transaction.
 */
@Injectable()
export class ManualPaymentsService {
  constructor(
    private readonly platformDb: PlatformDb,
    private readonly settlement: InvoiceSettlementService,
    private readonly state: SubscriptionStateService,
    private readonly audit: PlatformAuditService,
    private readonly clock: Clock,
  ) {}

  list(query: ListManualPaymentsQuery): Promise<Page<ManualPaymentView>> {
    const after = decodeUuidCursor(query.cursor);
    return this.platformDb.run(async (tx) => {
      const rows = await tx.manualPayment.findMany({
        where: {
          ...(query.status ? { status: query.status } : {}),
          ...(after ? { id: { lt: after } } : {}),
        },
        include: { invoice: { select: { number: true } } },
        orderBy: { id: 'desc' },
        take: query.limit + 1,
      });
      return Page.fromRows(rows, query.limit, (row) => toView(row, row.invoice.number), (row) => row.id);
    });
  }

  /** Saisie : le montant doit être exactement celui de la facture (pas de règlement partiel). */
  async create(invoiceId: string, input: CreateManualPaymentInput, principal: PlatformPrincipal): Promise<ManualPaymentView> {
    try {
      return await this.platformDb.run(async (tx) => {
        const invoice = await tx.saasInvoice.findFirst({ where: { id: invoiceId, status: { not: 'draft' } } });
        if (!invoice) throw DomainError.notFound('Facture');
        if (!(PAYABLE_STATUSES as readonly string[]).includes(invoice.status)) {
          throw DomainError.conflict('invoice_not_payable', 'Cette facture ne peut plus être réglée.');
        }
        if (!sameAmount(invoice.total.toFixed(2), input.amount)) {
          throw DomainError.unprocessable('amount_mismatch', `Le montant doit être exactement celui de la facture (${invoice.total.toFixed(2)} ${invoice.currency.trim()}).`);
        }
        const payment = await tx.manualPayment.create({
          data: {
            invoiceId: invoice.id,
            tenantId: invoice.tenantId,
            amount: invoice.total,
            currency: invoice.currency.trim(),
            method: input.method,
            reference: input.reference,
            receivedAt: new Date(input.receivedAt),
            enteredBy: principal.userId,
          },
        });
        await this.audit.record(tx, {
          action: 'manual_payment.entered',
          actor: actorOf(principal),
          resourceType: 'manual_payment',
          resourceId: payment.id,
          tenantId: invoice.tenantId,
          changes: { invoice: invoice.number, amount: payment.amount.toFixed(2), method: input.method },
        });
        return toView(payment, invoice.number);
      });
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw DomainError.conflict('manual_payment_pending', 'Un paiement manuel est déjà en attente de validation pour cette facture.');
      }
      throw error;
    }
  }

  /** Validation par un AUTRE utilisateur : règle la facture, active l'abonnement (même transaction), puis publie les événements. */
  async validate(paymentId: string, principal: PlatformPrincipal): Promise<ManualPaymentView> {
    const now = this.clock.now();
    await this.assertFourEyes(paymentId, principal);
    const { view, changes } = await this.platformDb.run(async (tx) => {
      const payment = await this.lockPending(tx, paymentId);
      const decided = await tx.manualPayment.update({
        where: { id: payment.id },
        data: { status: 'validated', validatedBy: principal.userId, decidedAt: now },
        include: { invoice: { select: { number: true } } },
      });
      const settled = await this.settlement.settleInTx(tx, payment.invoiceId, {
        paidAt: now,
        channel: `manual:${payment.method}`,
        actor: actorOf(principal),
        reference: payment.reference,
      });
      await this.audit.record(tx, {
        action: 'manual_payment.validated',
        actor: actorOf(principal),
        resourceType: 'manual_payment',
        resourceId: payment.id,
        tenantId: payment.tenantId,
        changes: { invoice: decided.invoice.number, enteredBy: payment.enteredBy },
      });
      return { view: toView(decided, decided.invoice.number), changes: settled.changes };
    });
    await this.state.publish(changes);
    return view;
  }

  async reject(paymentId: string, input: RejectManualPaymentInput, principal: PlatformPrincipal): Promise<ManualPaymentView> {
    const now = this.clock.now();
    await this.assertFourEyes(paymentId, principal);
    return this.platformDb.run(async (tx) => {
      const payment = await this.lockPending(tx, paymentId);
      const decided = await tx.manualPayment.update({
        where: { id: payment.id },
        data: { status: 'rejected', validatedBy: principal.userId, decidedAt: now, rejectionReason: input.reason },
        include: { invoice: { select: { number: true } } },
      });
      await this.audit.record(tx, {
        action: 'manual_payment.rejected',
        actor: actorOf(principal),
        resourceType: 'manual_payment',
        resourceId: payment.id,
        tenantId: payment.tenantId,
        changes: { invoice: decided.invoice.number, reason: input.reason },
      });
      return toView(decided, decided.invoice.number);
    });
  }

  /** Refus tracé (l'audit est validé avant que l'erreur ne soit levée) si le décideur est le saisisseur. */
  private async assertFourEyes(paymentId: string, principal: PlatformPrincipal): Promise<void> {
    const violated = await this.platformDb.run(async (tx) => {
      const payment = await tx.manualPayment.findUnique({ where: { id: paymentId }, select: { enteredBy: true, tenantId: true } });
      if (!payment) throw DomainError.notFound('Paiement manuel');
      if (payment.enteredBy !== principal.userId) return false;
      await this.audit.record(tx, {
        action: 'manual_payment.four_eyes_denied',
        actor: actorOf(principal),
        resourceType: 'manual_payment',
        resourceId: paymentId,
        tenantId: payment.tenantId,
        outcome: 'denied',
      });
      return true;
    });
    if (violated) throw DomainError.forbidden('four_eyes_required', 'Le paiement doit être validé par un autre utilisateur que celui qui l’a saisi.');
  }

  private async lockPending(tx: PlatformTx, paymentId: string): Promise<ManualPayment> {
    await tx.$queryRaw`SELECT id FROM platform.manual_payments WHERE id = ${paymentId}::uuid FOR UPDATE`;
    const payment = await tx.manualPayment.findUnique({ where: { id: paymentId } });
    if (!payment) throw DomainError.notFound('Paiement manuel');
    if (payment.status !== 'pending') throw DomainError.conflict('manual_payment_decided', 'Ce paiement manuel a déjà été traité.');
    return payment;
  }
}

/** Égalité décimale exacte entre `"25000.00"` et `"25000"` / `"25000.0"`, sans flottant. */
function sameAmount(expected: string, received: string): boolean {
  const normalize = (value: string): string => {
    const [units = '0', cents = ''] = value.split('.');
    return `${units.replace(/^0+(?=\d)/, '')}.${cents.padEnd(2, '0')}`;
  };
  return normalize(expected) === normalize(received);
}
