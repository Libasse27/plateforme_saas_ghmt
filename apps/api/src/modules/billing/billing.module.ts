import { Module } from '@nestjs/common';
import { CashierController } from './controllers/cashier.controller';
import { InvoicesController } from './controllers/invoices.controller';
import { PriceListsController } from './controllers/price-lists.controller';
import { CashierRepository } from './repositories/cashier.repository';
import { InvoicesRepository } from './repositories/invoices.repository';
import { PriceListsRepository } from './repositories/price-lists.repository';
import { CashRegistersService } from './services/cash-registers.service';
import { CashSessionsService } from './services/cash-sessions.service';
import { InvoiceLinesResolver } from './services/invoice-lines.resolver';
import { InvoicePaymentsService } from './services/invoice-payments.service';
import { InvoicesService } from './services/invoices.service';
import { OnlinePaymentEventsService } from './services/online-payment-events.service';
import { PriceListsService } from './services/price-lists.service';
import { SiteScopeService } from './services/site-scope.service';

/**
 * Module billing (docs/09 §C2) : grille tarifaire, factures patient, encaissements (espèces, Mobile Money via
 * `PAYMENTS_GATEWAY`), caisse. Réagit à `payment.succeeded|failed` de purpose `patient_invoice`.
 */
@Module({
  controllers: [PriceListsController, InvoicesController, CashierController],
  providers: [
    PriceListsRepository,
    InvoicesRepository,
    CashierRepository,
    SiteScopeService,
    PriceListsService,
    InvoiceLinesResolver,
    InvoicesService,
    InvoicePaymentsService,
    OnlinePaymentEventsService,
    CashRegistersService,
    CashSessionsService,
  ],
})
export class BillingModule {}
