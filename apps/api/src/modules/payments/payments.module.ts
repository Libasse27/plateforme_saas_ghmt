import { Global, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PAYMENTS_GATEWAY } from '../../common/payments/payments-gateway';
import { WebhooksController } from './controllers/webhooks.controller';
import { PAYMENTS_FETCH } from './payments.constants';
import { ProviderRegistry } from './providers/provider-registry';
import { PaymentsRepository } from './repositories/payments.repository';
import { PaymentRetryJob } from './services/payment-retry.job';
import { PaymentSettlementService } from './services/payment-settlement.service';
import { PaymentsGatewayService } from './services/payments-gateway.service';
import { SandboxSimulationService } from './services/sandbox-simulation.service';
import { WebhookService } from './services/webhook.service';

/**
 * Module payments (docs/05 A9, docs/09 §C1) : passerelle de paiement `PAYMENTS_GATEWAY` partagée par la facturation
 * patient et les abonnements SaaS, fournisseurs sandbox et CinetPay, webhooks et relance des tentatives.
 */
@Global()
@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [WebhooksController],
  providers: [
    { provide: PAYMENTS_FETCH, useValue: fetch },
    PaymentsRepository,
    ProviderRegistry,
    PaymentSettlementService,
    PaymentsGatewayService,
    { provide: PAYMENTS_GATEWAY, useExisting: PaymentsGatewayService },
    WebhookService,
    SandboxSimulationService,
    PaymentRetryJob,
  ],
  exports: [PAYMENTS_GATEWAY],
})
export class PaymentsModule {}
