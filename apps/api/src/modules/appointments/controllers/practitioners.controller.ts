import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  createPractitionerSchema,
  listPractitionersSchema,
  updatePractitionerSchema,
  type CreatePractitionerInput,
  type ListPractitionersInput,
  type UpdatePractitionerInput,
} from '@ghmt/shared';
import { RequirePermission } from '../../../common/decorators/auth.decorators';
import type { Page } from '../../../common/pagination/page';
import { UuidPipe } from '../../../common/pipes/uuid.pipe';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import type { PractitionerView } from '../mappers/practitioner.mapper';
import { PractitionersService } from '../services/practitioners.service';

@Controller('practitioners')
export class PractitionersController {
  constructor(private readonly practitioners: PractitionersService) {}

  @Get()
  @RequirePermission('appointments:agenda:read')
  list(@Query(new ZodValidationPipe(listPractitionersSchema)) query: ListPractitionersInput): Promise<Page<PractitionerView>> {
    return this.practitioners.list(query);
  }

  @Post()
  @RequirePermission('appointments:agenda:update')
  create(@Body(new ZodValidationPipe(createPractitionerSchema)) body: CreatePractitionerInput): Promise<PractitionerView> {
    return this.practitioners.create(body);
  }

  @Get(':id')
  @RequirePermission('appointments:agenda:read')
  get(@Param('id', UuidPipe) id: string): Promise<PractitionerView> {
    return this.practitioners.get(id);
  }

  @Patch(':id')
  @RequirePermission('appointments:agenda:update')
  update(
    @Param('id', UuidPipe) id: string,
    @Body(new ZodValidationPipe(updatePractitionerSchema)) body: UpdatePractitionerInput,
  ): Promise<PractitionerView> {
    return this.practitioners.update(id, body);
  }
}
