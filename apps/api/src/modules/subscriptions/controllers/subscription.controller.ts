import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  changePlanSchema,
  listSaasInvoicesQuerySchema,
  payInvoiceSchema,
  type ChangePlanInput,
  type ListSaasInvoicesQuery,
  type PayInvoiceInput,
} from '@ghmt/shared';
import { RequirePermission } from '../../../common/decorators/auth.decorators';
import { AllowWhenSuspended } from '../../../common/decorators/realm.decorators';
import { UuidPipe } from '../../../common/pipes/uuid.pipe';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { SubscriptionsService } from '../services/subscriptions.service';
import { TenantInvoicesService } from '../services/tenant-invoices.service';

/** Abonnement SaaS de l'établissement courant (docs/09 §A2-A4). Le tenant vient exclusivement du jeton. */
@Controller('subscription')
export class SubscriptionController {
  constructor(
    private readonly subscriptions: SubscriptionsService,
    private readonly invoices: TenantInvoicesService,
  ) {}

  @Get()
  @RequirePermission('settings:establishment:read')
  get() {
    return this.subscriptions.get();
  }

  @Get('plans')
  @RequirePermission('settings:establishment:read')
  listPlans() {
    return this.subscriptions.listPlans();
  }

  /** Autorisé en suspension : c'est la voie de réactivation (le plan est appliqué au paiement de la facture). */
  @Post('change')
  @HttpCode(200)
  @AllowWhenSuspended()
  @RequirePermission('settings:establishment:update')
  change(@Body(new ZodValidationPipe(changePlanSchema)) body: ChangePlanInput) {
    return this.subscriptions.change(body);
  }

  @Post('cancel')
  @HttpCode(200)
  @RequirePermission('settings:establishment:update')
  cancel() {
    return this.subscriptions.cancel();
  }

  @Post('resume')
  @HttpCode(200)
  @RequirePermission('settings:establishment:update')
  resume() {
    return this.subscriptions.resume();
  }

  @Get('invoices')
  @RequirePermission('settings:establishment:read')
  listInvoices(@Query(new ZodValidationPipe(listSaasInvoicesQuerySchema)) query: ListSaasInvoicesQuery) {
    return this.invoices.list(query);
  }

  /** Autorisé en suspension : l'administrateur doit pouvoir régler pour retrouver l'accès complet. */
  @Post('invoices/:id/pay')
  @HttpCode(200)
  @AllowWhenSuspended()
  @RequirePermission('settings:establishment:update')
  pay(@Param('id', UuidPipe) id: string, @Body(new ZodValidationPipe(payInvoiceSchema)) body: PayInvoiceInput) {
    return this.invoices.pay(id, body);
  }
}
