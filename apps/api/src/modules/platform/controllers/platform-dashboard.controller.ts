import { Get, Query } from '@nestjs/common';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { PlatformController, RequirePlatformPermission } from '../auth/platform.decorators';
import { PlatformAuditLogsService, listAuditLogsQuerySchema, type ListAuditLogsQuery } from '../services/platform-audit-logs.service';
import { PlatformDashboardService } from '../services/platform-dashboard.service';

/** Tableau de bord (`/platform/dashboard`) et journal d'audit (`/platform/dashboard/audit-logs`). */
@PlatformController('dashboard')
export class PlatformDashboardController {
  constructor(
    private readonly dashboard: PlatformDashboardService,
    private readonly auditLogs: PlatformAuditLogsService,
  ) {}

  @Get()
  @RequirePlatformPermission('dashboard:read')
  get() {
    return this.dashboard.get();
  }

  @Get('audit-logs')
  @RequirePlatformPermission('audit:read')
  listAuditLogs(@Query(new ZodValidationPipe(listAuditLogsQuerySchema)) query: ListAuditLogsQuery) {
    return this.auditLogs.list(query);
  }
}
