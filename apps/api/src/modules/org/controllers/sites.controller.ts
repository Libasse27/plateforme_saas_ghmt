import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { createSiteSchema, updateSiteSchema } from '@ghmt/shared';
import { RequirePermission } from '../../../common/decorators/auth.decorators';
import { UuidPipe } from '../../../common/pipes/uuid.pipe';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import type { CreateSiteInput, UpdateSiteInput } from '../services/org.types';
import { SitesService } from '../services/sites.service';

@Controller('org/sites')
export class SitesController {
  constructor(private readonly sites: SitesService) {}

  @Get()
  @RequirePermission('org:site:read')
  list() {
    return this.sites.list();
  }

  @Get(':id')
  @RequirePermission('org:site:read')
  get(@Param('id', UuidPipe) id: string) {
    return this.sites.get(id);
  }

  @Post()
  @RequirePermission('org:site:create')
  create(@Body(new ZodValidationPipe(createSiteSchema)) body: CreateSiteInput) {
    return this.sites.create(body);
  }

  @Patch(':id')
  @RequirePermission('org:site:update')
  update(@Param('id', UuidPipe) id: string, @Body(new ZodValidationPipe(updateSiteSchema)) body: UpdateSiteInput) {
    return this.sites.update(id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('org:site:delete')
  remove(@Param('id', UuidPipe) id: string): Promise<void> {
    return this.sites.remove(id);
  }
}
