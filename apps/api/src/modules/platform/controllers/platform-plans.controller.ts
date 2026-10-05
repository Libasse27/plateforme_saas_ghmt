import { Body, Get, HttpCode, Post, Query } from '@nestjs/common';
import { createPlanVersionSchema, listPlansQuerySchema, type CreatePlanVersionInput } from '@ghmt/shared';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import type { PlatformPrincipal } from '../auth/platform-auth.guard';
import { CurrentPlatformUser, PlatformController, RequirePlatformPermission } from '../auth/platform.decorators';
import { PlatformPlansService } from '../services/platform-plans.service';

/** Catalogue des plans : liste et création d'une nouvelle version. */
@PlatformController('plans')
export class PlatformPlansController {
  constructor(private readonly plans: PlatformPlansService) {}

  @Get()
  @RequirePlatformPermission('plans:read')
  list(@Query(new ZodValidationPipe(listPlansQuerySchema)) query: { includeArchived: boolean }) {
    return this.plans.list(query.includeArchived);
  }

  @Post()
  @HttpCode(201)
  @RequirePlatformPermission('plans:write')
  create(@Body(new ZodValidationPipe(createPlanVersionSchema)) body: CreatePlanVersionInput, @CurrentPlatformUser() principal: PlatformPrincipal) {
    return this.plans.createVersion(body, principal);
  }
}
