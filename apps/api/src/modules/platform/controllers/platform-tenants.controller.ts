import { Body, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  listPlatformTenantsQuerySchema,
  suspendTenantSchema,
  type ListPlatformTenantsQuery,
  type SuspendTenantInput,
} from '@ghmt/shared';
import { UuidPipe } from '../../../common/pipes/uuid.pipe';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import type { PlatformPrincipal } from '../auth/platform-auth.guard';
import { CurrentPlatformUser, PlatformController, RequirePlatformPermission } from '../auth/platform.decorators';
import { PlatformTenantsService } from '../services/platform-tenants.service';

/** Établissements : liste, détail (usage agrégé), suspension et réactivation motivées. */
@PlatformController('tenants')
export class PlatformTenantsController {
  constructor(private readonly tenants: PlatformTenantsService) {}

  @Get()
  @RequirePlatformPermission('tenants:read')
  list(@Query(new ZodValidationPipe(listPlatformTenantsQuerySchema)) query: ListPlatformTenantsQuery) {
    return this.tenants.list(query);
  }

  @Get(':id')
  @RequirePlatformPermission('tenants:read')
  detail(@Param('id', UuidPipe) id: string) {
    return this.tenants.detail(id);
  }

  @Post(':id/suspend')
  @HttpCode(200)
  @RequirePlatformPermission('tenants:suspend')
  suspend(
    @Param('id', UuidPipe) id: string,
    @Body(new ZodValidationPipe(suspendTenantSchema)) body: SuspendTenantInput,
    @CurrentPlatformUser() principal: PlatformPrincipal,
  ) {
    return this.tenants.suspend(id, body, principal);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  @RequirePlatformPermission('tenants:suspend')
  reactivate(@Param('id', UuidPipe) id: string, @CurrentPlatformUser() principal: PlatformPrincipal) {
    return this.tenants.reactivate(id, principal);
  }
}
