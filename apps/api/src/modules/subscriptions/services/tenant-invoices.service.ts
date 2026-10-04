import { createHash } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { ListSaasInvoicesQuery, PayInvoiceInput, PayInvoiceView, SaasInvoiceView } from '@ghmt/shared';
import { AuditService } from '../../../common/audit/audit.service';
import { RequestContext } from '../../../common/context/request-context';
import { DomainError } from '../../../common/errors/domain-error';
import { Page, decodeDateIdCursor } from '../../../common/pagination/page';
import { PAYMENTS_GATEWAY, type PaymentsGateway } from '../../../common/payments/payments-gateway';
import { Clock } from '../../../common/time/clock';
import { PlatformDb } from '../../../infrastructure/prisma/platform-db.service';
import { TenantDb } from '../../../infrastructure/prisma/tenant-db.service';
import { toSaasInvoiceView } from '../mappers/subscription.mapper';

/** Fenêtre de déduplication des tentatives de paiement : un double-clic ne crée pas deux paiements. */
const IDEMPOTENCY_WINDOW_MS = 5 * 60_000;

/** Factures SaaS du tenant courant : liste et lancement du paiement Mobile Money via `PAYMENTS_GATEWAY`. */
@Injectable()
export class TenantInvoicesService {
  constructor(
    private readonly platformDb: PlatformDb,
    private readonly tenantDb: TenantDb,
    private readonly context: RequestContext,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    @Optional() @Inject(PAYMENTS_GATEWAY) private readonly gateway?: PaymentsGateway,
  ) {}

  async list(query: ListSaasInvoicesQuery): Promise<Page<SaasInvoiceView>> {
    const { tenantId } = this.context.requirePrincipal();
    const after = decodeDateIdCursor(query.cursor);
    const rows = await this.platformDb.run((tx) =>
      tx.saasInvoice.findMany({
        where: {
          tenantId,
          status: query.status ?? { not: 'draft' },
          ...(after
            ? { OR: [{ issuedAt: { lt: after.date } }, { issuedAt: after.date, id: { lt: after.id } }] }
            : {}),
        },
        include: { lines: true },
        orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
      }),
    );
    return Page.fromRows(rows, query.limit, toSaasInvoiceView, (row) => `${row.issuedAt.toISOString()}|${row.id}`);
  }

  /** Lance le paiement Mobile Money d'une facture ouverte du tenant courant (toute autre facture ⇒ 404). */
  async pay(invoiceId: string, input: PayInvoiceInput): Promise<PayInvoiceView> {
    const principal = this.context.requirePrincipal();
    const gateway = this.gateway;
    if (!gateway) throw new DomainError('payments_unavailable', 503, 'Service Unavailable', 'Le paiement en ligne est momentanément indisponible.');

    const invoice = await this.platformDb.run((tx) => tx.saasInvoice.findFirst({ where: { id: invoiceId, tenantId: principal.tenantId } }));
    if (!invoice) throw DomainError.notFound('Facture');
    if (invoice.status !== 'open') throw DomainError.conflict('invoice_not_payable', 'Cette facture ne peut plus être réglée.');

    const bucket = Math.floor(this.clock.now().getTime() / IDEMPOTENCY_WINDOW_MS);
    const phoneDigest = createHash('sha256').update(input.payerPhone).digest('hex').slice(0, 16);
    const initiated = await gateway.initiate({
      purpose: 'saas_invoice',
      tenantId: principal.tenantId,
      referenceId: invoice.id,
      amount: invoice.total.toFixed(2),
      currency: invoice.currency.trim(),
      channel: 'mobile_money',
      payerPhone: input.payerPhone,
      description: `Facture ${invoice.number}`,
      idempotencyKey: `saas_invoice:${invoice.id}:${phoneDigest}:${bucket}`,
    });
    await this.tenantDb.run((tx) =>
      this.audit.record(tx, principal.tenantId, {
        action: 'subscription.invoice_payment_initiated',
        resourceType: 'saas_invoice',
        resourceId: invoice.id,
        changes: { number: invoice.number, attemptId: initiated.attemptId, provider: initiated.provider, amount: invoice.total.toFixed(2) },
      }),
    );
    return {
      attemptId: initiated.attemptId,
      status: initiated.status,
      provider: initiated.provider,
      checkoutUrl: initiated.checkoutUrl,
      instructions: initiated.instructions,
    };
  }
}
