import { Controller, Get, Query } from '@nestjs/common';
import { dashboardQuerySchema, type DashboardQuery, type EstablishmentDashboardView } from '@ghmt/shared';
import { RequirePermission } from '../../../common/decorators/auth.decorators';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { DashboardService } from '../services/dashboard.service';

/** Tableaux de bord (docs/10 §6) : sections filtrées par permissions, modules et portées du lecteur. */
@Controller('dashboards')
export class DashboardsController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('establishment')
  @RequirePermission('reports:dashboard:read')
  establishment(@Query(new ZodValidationPipe(dashboardQuerySchema)) query: DashboardQuery): Promise<EstablishmentDashboardView> {
    return this.dashboard.establishment(query);
  }
}
