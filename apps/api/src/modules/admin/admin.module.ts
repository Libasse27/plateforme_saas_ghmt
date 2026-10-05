import { Module } from '@nestjs/common';
import { AUDIT_EXPORT_MAX_ROWS } from '@ghmt/shared';
import { AUDIT_EXPORT_LIMIT } from './admin.constants';
import { AuditLogsController } from './controllers/audit-logs.controller';
import { DashboardsController } from './controllers/dashboards.controller';
import { DashboardRepository } from './repositories/dashboard.repository';
import { AuditLogsRepository } from './repositories/audit-logs.repository';
import { AuditVerifyLimiter } from './services/audit-verify-limiter';
import { AuditChainVerificationService } from './services/audit-chain-verification.service';
import { AuditExportService } from './services/audit-export.service';
import { AuditLogsService } from './services/audit-logs.service';
import { DashboardService } from './services/dashboard.service';

/** Console d'administration de l'établissement : journal d'audit et tableau de bord (docs/10 §6). */
@Module({
  controllers: [AuditLogsController, DashboardsController],
  providers: [
    { provide: AUDIT_EXPORT_LIMIT, useValue: AUDIT_EXPORT_MAX_ROWS },
    AuditLogsRepository,
    AuditLogsService,
    AuditExportService,
    AuditChainVerificationService,
    AuditVerifyLimiter,
    DashboardRepository,
    DashboardService,
  ],
})
export class AdminModule {}
