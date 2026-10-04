import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
  createRoleSchema,
  updateRoleSchema,
  type CreateRoleInput,
  type UpdateRoleInput,
} from '@ghmt/shared';
import { RequirePermission } from '../../../common/decorators/auth.decorators';
import { UuidPipe } from '../../../common/pipes/uuid.pipe';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RolesService } from '../services/roles.service';

@Controller('iam')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get('permissions')
  @RequirePermission('iam:role:read')
  permissions() {
    return this.roles.permissionCatalog();
  }

  @Get('roles')
  @RequirePermission('iam:role:read')
  list() {
    return this.roles.list();
  }

  @Get('roles/:id')
  @RequirePermission('iam:role:read')
  get(@Param('id', UuidPipe) id: string) {
    return this.roles.get(id);
  }

  @Post('roles')
  @RequirePermission('iam:role:create')
  create(@Body(new ZodValidationPipe(createRoleSchema)) body: CreateRoleInput) {
    return this.roles.create(body);
  }

  @Patch('roles/:id')
  @RequirePermission('iam:role:update')
  update(@Param('id', UuidPipe) id: string, @Body(new ZodValidationPipe(updateRoleSchema)) body: UpdateRoleInput) {
    return this.roles.update(id, body);
  }

  @Delete('roles/:id')
  @HttpCode(204)
  @RequirePermission('iam:role:delete')
  remove(@Param('id', UuidPipe) id: string): Promise<void> {
    return this.roles.remove(id);
  }
}
