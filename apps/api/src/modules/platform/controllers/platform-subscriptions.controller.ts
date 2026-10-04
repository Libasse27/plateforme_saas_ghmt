import { Body, Get, HttpCode, Param, Post } from '@nestjs/common';
import { platformChangePlanSchema, type PlatformChangePlanInput } from '@ghmt/shared';
import { UuidPipe } from '../../../common/pipes/uuid.pipe';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import type { PlatformPrincipal } from '../auth/platform-auth.guard';
import { CurrentPlatformUser, PlatformController, RequirePlatformPermission } from '../auth/platform.decorators';
import { PlatformSubscriptionsService } from '../services/platform-subscriptions.service';

/** Abonnement d'un établissement : consultation, changement de plan (avec dérogations), prolongation de l'essai. */
@PlatformController('subscriptions')
export class PlatformSubscriptionsController {
  constructor(private readonly subscriptions: PlatformSubscriptionsService) {}

  @Get(':tenantId')
  @RequirePlatformPermission('subscriptions:read')
  get(@Param('tenantId', UuidPipe) tenantId: string) {
    return this.subscriptions.get(tenantId);
  }

  @Post(':tenantId/change')
  @HttpCode(200)
  @RequirePlatformPermission('subscriptions:write')
  change(
    @Param('tenantId', UuidPipe) tenantId: string,
    @Body(new ZodValidationPipe(platformChangePlanSchema)) body: PlatformChangePlanInput,
    @CurrentPlatformUser() principal: PlatformPrincipal,
  ) {
    return this.subscriptions.changePlan(tenantId, body, principal);
  }

  @Post(':tenantId/extend-trial')
  @HttpCode(200)
  @RequirePlatformPermission('subscriptions:write')
  extendTrial(@Param('tenantId', UuidPipe) tenantId: string, @CurrentPlatformUser() principal: PlatformPrincipal) {
    return this.subscriptions.extendTrial(tenantId, principal);
  }
}
