import { Body, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  createManualPaymentSchema,
  listManualPaymentsQuerySchema,
  listPlatformInvoicesQuerySchema,
  rejectManualPaymentSchema,
  type CreateManualPaymentInput,
  type ListManualPaymentsQuery,
  type ListPlatformInvoicesQuery,
  type RejectManualPaymentInput,
} from '@ghmt/shared';
import { UuidPipe } from '../../../common/pipes/uuid.pipe';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import type { PlatformPrincipal } from '../auth/platform-auth.guard';
import { CurrentPlatformUser, PlatformController, RequirePlatformPermission } from '../auth/platform.decorators';
import { ManualPaymentsService } from '../services/manual-payments.service';
import { PlatformInvoicesService } from '../services/platform-invoices.service';

/** Factures SaaS et paiements manuels (saisie puis validation par un autre utilisateur). */
@PlatformController('invoices')
export class PlatformInvoicesController {
  constructor(
    private readonly invoices: PlatformInvoicesService,
    private readonly manualPayments: ManualPaymentsService,
  ) {}

  @Get()
  @RequirePlatformPermission('invoices:read')
  list(@Query(new ZodValidationPipe(listPlatformInvoicesQuerySchema)) query: ListPlatformInvoicesQuery) {
    return this.invoices.list(query);
  }

  /** Déclaré avant `:id` : « manual-payments » ne doit pas être pris pour un identifiant de facture. */
  @Get('manual-payments')
  @RequirePlatformPermission('invoices:read')
  listManualPayments(@Query(new ZodValidationPipe(listManualPaymentsQuerySchema)) query: ListManualPaymentsQuery) {
    return this.manualPayments.list(query);
  }

  @Post('manual-payments/:paymentId/validate')
  @HttpCode(200)
  @RequirePlatformPermission('invoices:validate')
  validate(@Param('paymentId', UuidPipe) paymentId: string, @CurrentPlatformUser() principal: PlatformPrincipal) {
    return this.manualPayments.validate(paymentId, principal);
  }

  @Post('manual-payments/:paymentId/reject')
  @HttpCode(200)
  @RequirePlatformPermission('invoices:validate')
  reject(
    @Param('paymentId', UuidPipe) paymentId: string,
    @Body(new ZodValidationPipe(rejectManualPaymentSchema)) body: RejectManualPaymentInput,
    @CurrentPlatformUser() principal: PlatformPrincipal,
  ) {
    return this.manualPayments.reject(paymentId, body, principal);
  }

  @Get(':id')
  @RequirePlatformPermission('invoices:read')
  get(@Param('id', UuidPipe) id: string) {
    return this.invoices.get(id);
  }

  @Post(':id/manual-payments')
  @HttpCode(201)
  @RequirePlatformPermission('invoices:write')
  enterManualPayment(
    @Param('id', UuidPipe) id: string,
    @Body(new ZodValidationPipe(createManualPaymentSchema)) body: CreateManualPaymentInput,
    @CurrentPlatformUser() principal: PlatformPrincipal,
  ) {
    return this.manualPayments.create(id, body, principal);
  }
}
