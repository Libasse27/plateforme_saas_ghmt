import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TotpService } from '../auth/services/totp.service';
import { PlatformAuthGuard } from './auth/platform-auth.guard';
import { PlatformLoginService } from './auth/platform-login.service';
import { PlatformPasswordService } from './auth/platform-password.service';
import { PlatformRefreshService } from './auth/platform-refresh.service';
import { PlatformSessionsService } from './auth/platform-sessions.service';
import { PlatformTokenService } from './auth/platform-token.service';
import { PlatformAuthController } from './controllers/platform-auth.controller';
import { PlatformDashboardController } from './controllers/platform-dashboard.controller';
import { PlatformInvoicesController } from './controllers/platform-invoices.controller';
import { PlatformPlansController } from './controllers/platform-plans.controller';
import { PlatformSubscriptionsController } from './controllers/platform-subscriptions.controller';
import { PlatformTenantsController } from './controllers/platform-tenants.controller';
import { ManualPaymentsService } from './services/manual-payments.service';
import { PlatformAuditLogsService } from './services/platform-audit-logs.service';
import { PlatformDashboardService } from './services/platform-dashboard.service';
import { PlatformInvoicesService } from './services/platform-invoices.service';
import { PlatformPlansService } from './services/platform-plans.service';
import { PlatformSubscriptionsService } from './services/platform-subscriptions.service';
import { PlatformTenantsService } from './services/platform-tenants.service';

/**
 * Realm plateforme (docs/09 §A1, §A5) : authentification du Super Administrateur (MFA obligatoire) et console `/platform/*`.
 * Les guards tenant laissent passer ces routes (`@PlatformRealm`) ; `PlatformAuthGuard` les protège.
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [
    PlatformAuthController,
    PlatformTenantsController,
    PlatformPlansController,
    PlatformSubscriptionsController,
    PlatformInvoicesController,
    PlatformDashboardController,
  ],
  providers: [
    TotpService,
    PlatformTokenService,
    PlatformSessionsService,
    PlatformLoginService,
    PlatformPasswordService,
    PlatformRefreshService,
    PlatformAuthGuard,
    PlatformTenantsService,
    PlatformPlansService,
    PlatformSubscriptionsService,
    PlatformInvoicesService,
    ManualPaymentsService,
    PlatformDashboardService,
    PlatformAuditLogsService,
  ],
})
export class PlatformModule {}
