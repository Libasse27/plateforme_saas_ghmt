import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { createDepartmentSchema, listDepartmentsQuerySchema, updateDepartmentSchema, type ListDepartmentsQuery } from '@ghmt/shared';
import { RequirePermission } from '../../../common/decorators/auth.decorators';
import { UuidPipe } from '../../../common/pipes/uuid.pipe';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { DepartmentsService } from '../services/departments.service';
import type { CreateDepartmentInput, UpdateDepartmentInput } from '../services/org.types';

@Controller('org/departments')
export class DepartmentsController {
  constructor(private readonly departments: DepartmentsService) {}

  @Get()
  @RequirePermission('org:service:read')
  list(@Query(new ZodValidationPipe(listDepartmentsQuerySchema)) query: ListDepartmentsQuery) {
    return this.departments.list(query.siteId);
  }

  @Get(':id')
  @RequirePermission('org:service:read')
  get(@Param('id', UuidPipe) id: string) {
    return this.departments.get(id);
  }

  @Post()
  @RequirePermission('org:service:create')
  create(@Body(new ZodValidationPipe(createDepartmentSchema)) body: CreateDepartmentInput) {
    return this.departments.create(body);
  }

  @Patch(':id')
  @RequirePermission('org:service:update')
  update(@Param('id', UuidPipe) id: string, @Body(new ZodValidationPipe(updateDepartmentSchema)) body: UpdateDepartmentInput) {
    return this.departments.update(id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('org:service:delete')
  remove(@Param('id', UuidPipe) id: string): Promise<void> {
    return this.departments.remove(id);
  }
}
