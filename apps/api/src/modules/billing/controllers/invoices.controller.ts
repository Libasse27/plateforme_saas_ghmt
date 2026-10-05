import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import {
  createInvoiceSchema,
  listInvoicesSchema,
  recordPaymentSchema,
  replaceInvoiceLinesSchema,
  voidInvoiceSchema,
  type CreateInvoiceInput,
  type AbandonPaymentView,
  type InvoiceDetailView,
  type InvoicePaymentView,
  type InvoiceSummaryView,
  type ListInvoicesInput,
  type OnlinePaymentView,
  type ReceiptView,
  type RecordPaymentInput,
  type ReplaceInvoiceLinesInput,
  type VoidInvoiceInput,
} from '@ghmt/shared';
import { RequirePermission } from '../../../common/decorators/auth.decorators';
import type { Page } from '../../../common/pagination/page';
import { UuidPipe } from '../../../common/pipes/uuid.pipe';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { InvoicePaymentsService } from '../services/invoice-payments.service';
import { InvoicesService } from '../services/invoices.service';

/** Factures patient et encaissements (docs/09 §C2). */
@Controller('billing')
export class InvoicesController {
  constructor(
    private readonly invoices: InvoicesService,
    private readonly payments: InvoicePaymentsService,
  ) {}

  @Post('invoices')
  @RequirePermission('billing:invoice:create')
  create(@Body(new ZodValidationPipe(createInvoiceSchema)) body: CreateInvoiceInput): Promise<InvoiceDetailView> {
    return this.invoices.create(body);
  }

  @Get('invoices')
  @RequirePermission('billing:invoice:read')
  list(@Query(new ZodValidationPipe(listInvoicesSchema)) query: ListInvoicesInput): Promise<Page<InvoiceSummaryView>> {
    return this.invoices.list(query);
  }

  @Get('invoices/:id')
  @RequirePermission('billing:invoice:read')
  get(@Param('id', UuidPipe) id: string): Promise<InvoiceDetailView> {
    return this.invoices.get(id);
  }

  @Get('invoices/:id/receipt')
  @RequirePermission('billing:invoice:print')
  receipt(@Param('id', UuidPipe) id: string): Promise<ReceiptView> {
    return this.invoices.receipt(id);
  }

  @Put('invoices/:id/lines')
  @RequirePermission('billing:invoice:create')
  replaceLines(@Param('id', UuidPipe) id: string, @Body(new ZodValidationPipe(replaceInvoiceLinesSchema)) body: ReplaceInvoiceLinesInput): Promise<InvoiceDetailView> {
    return this.invoices.replaceLines(id, body);
  }

  @Post('invoices/:id/issue')
  @HttpCode(200)
  @RequirePermission('billing:invoice:create')
  issue(@Param('id', UuidPipe) id: string): Promise<InvoiceDetailView> {
    return this.invoices.issue(id);
  }

  @Post('invoices/:id/void')
  @HttpCode(200)
  @RequirePermission('billing:invoice:validate')
  voidInvoice(@Param('id', UuidPipe) id: string, @Body(new ZodValidationPipe(voidInvoiceSchema)) body: VoidInvoiceInput): Promise<InvoiceDetailView> {
    return this.invoices.voidInvoice(id, body);
  }

  /** Espèces / autre : renvoie le paiement ; Mobile Money / carte : renvoie `{ payment, checkoutUrl, instructions }`. */
  @Post('invoices/:id/payments')
  @RequirePermission('cashier:payment:create')
  pay(@Param('id', UuidPipe) id: string, @Body(new ZodValidationPipe(recordPaymentSchema)) body: RecordPaymentInput): Promise<InvoicePaymentView | OnlinePaymentView> {
    return this.payments.record(id, body);
  }

  /** Abandon d'un paiement en ligne en attente : re-vérifie le fournisseur, libère le montant s'il n'y a pas eu de succès. */
  @Post('payments/:id/abandon')
  @HttpCode(200)
  @RequirePermission('cashier:payment:create')
  abandon(@Param('id', UuidPipe) id: string): Promise<AbandonPaymentView> {
    return this.payments.abandon(id);
  }

  @Post('payments/:id/refresh')
  @HttpCode(200)
  @RequirePermission('cashier:payment:create')
  refresh(@Param('id', UuidPipe) id: string): Promise<InvoicePaymentView> {
    return this.payments.refresh(id);
  }
}
