import { Global, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { EntitlementService } from '../../common/authz/entitlement.service';
import { PlatformAuditModule } from '../../common/audit/platform-audit.module';
import { SubscriptionController } from './controllers/subscription.controller';
import { SubscriptionsRepository } from './repositories/subscriptions.repository';
import { InvoiceIssuerService } from './services/invoice-issuer.service';
import { InvoiceSettlementService } from './services/invoice-settlement.service';
import { PlanChangeService } from './services/plan-change.service';
import { SubscriptionLifecycleService } from './services/subscription-lifecycle.service';
import { SubscriptionStateService } from './services/subscription-state.service';
import { SubscriptionsService } from './services/subscriptions.service';
import { TenantInvoicesService } from './services/tenant-invoices.service';
import { TenantModulesSync } from './services/tenant-modules-sync';

/**
 * Abonnements SaaS (docs/09 §A2-A4). Module global : `EntitlementService` est consommé par iam, org et appointments
 * (limites du plan) sans dépendance de module à module.
 */
@Global()
@Module({
  imports: [ScheduleModule.forRoot(), PlatformAuditModule],
  controllers: [SubscriptionController],
  providers: [
    EntitlementService,
    SubscriptionsRepository,
    SubscriptionStateService,
    InvoiceIssuerService,
    InvoiceSettlementService,
    PlanChangeService,
    SubscriptionLifecycleService,
    SubscriptionsService,
    TenantInvoicesService,
    TenantModulesSync,
  ],
  exports: [
    EntitlementService,
    SubscriptionsRepository,
    SubscriptionStateService,
    InvoiceIssuerService,
    InvoiceSettlementService,
    PlanChangeService,
    SubscriptionLifecycleService,
    TenantModulesSync,
  ],
})
export class SubscriptionsModule {}
