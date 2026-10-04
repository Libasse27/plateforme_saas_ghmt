import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import {
  createAssignmentSchema,
  createUserSchema,
  listUsersQuerySchema,
  updateUserSchema,
  type CreateAssignmentInput,
  type CreateUserInput,
  type ListUsersQuery,
  type UpdateUserInput,
} from '@ghmt/shared';
import { RequirePermission } from '../../../common/decorators/auth.decorators';
import { UuidPipe } from '../../../common/pipes/uuid.pipe';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { AssignmentsService } from '../services/assignments.service';
import { UsersService } from '../services/users.service';

@Controller('iam/users')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly assignments: AssignmentsService,
  ) {}

  @Get()
  @RequirePermission('iam:user:read')
  list(@Query(new ZodValidationPipe(listUsersQuerySchema)) query: ListUsersQuery) {
    return this.users.list(query);
  }

  @Get(':id')
  @RequirePermission('iam:user:read')
  get(@Param('id', UuidPipe) id: string) {
    return this.users.get(id);
  }

  @Post()
  @RequirePermission('iam:user:create')
  create(@Body(new ZodValidationPipe(createUserSchema)) body: CreateUserInput) {
    return this.users.create(body);
  }

  @Patch(':id')
  @RequirePermission('iam:user:update')
  update(@Param('id', UuidPipe) id: string, @Body(new ZodValidationPipe(updateUserSchema)) body: UpdateUserInput) {
    return this.users.update(id, body);
  }

  @Post(':id/disable')
  @HttpCode(200)
  @RequirePermission('iam:user:update')
  disable(@Param('id', UuidPipe) id: string) {
    return this.users.disable(id);
  }

  @Post(':id/enable')
  @HttpCode(200)
  @RequirePermission('iam:user:update')
  enable(@Param('id', UuidPipe) id: string) {
    return this.users.enable(id);
  }

  @Post(':id/invitation')
  @HttpCode(204)
  @RequirePermission('iam:user:create')
  resendInvitation(@Param('id', UuidPipe) id: string): Promise<void> {
    return this.users.resendInvitation(id);
  }

  @Post(':id/unlock')
  @HttpCode(200)
  @RequirePermission('iam:user:update')
  unlock(@Param('id', UuidPipe) id: string) {
    return this.users.unlock(id);
  }

  @Delete(':id/sessions')
  @HttpCode(204)
  @RequirePermission('iam:session:delete')
  revokeSessions(@Param('id', UuidPipe) id: string): Promise<void> {
    return this.users.revokeSessions(id);
  }

  @Get(':id/assignments')
  @RequirePermission('iam:assignment:read')
  listAssignments(@Param('id', UuidPipe) id: string) {
    return this.assignments.list(id);
  }

  @Post(':id/assignments')
  @RequirePermission('iam:assignment:create')
  createAssignment(@Param('id', UuidPipe) id: string, @Body(new ZodValidationPipe(createAssignmentSchema)) body: CreateAssignmentInput) {
    return this.assignments.create(id, body);
  }

  @Delete(':id/assignments/:assignmentId')
  @HttpCode(204)
  @RequirePermission('iam:assignment:delete')
  revokeAssignment(@Param('id', UuidPipe) id: string, @Param('assignmentId', UuidPipe) assignmentId: string): Promise<void> {
    return this.assignments.revoke(id, assignmentId);
  }
}
