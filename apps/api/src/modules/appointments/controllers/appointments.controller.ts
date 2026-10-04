import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import {
  changeAppointmentStatusSchema,
  createAppointmentSchema,
  listAppointmentsSchema,
  rescheduleAppointmentSchema,
  type ChangeAppointmentStatusInput,
  type CreateAppointmentInput,
  type ListAppointmentsInput,
  type RescheduleAppointmentInput,
} from '@ghmt/shared';
import { RequirePermission } from '../../../common/decorators/auth.decorators';
import type { Page } from '../../../common/pagination/page';
import { UuidPipe } from '../../../common/pipes/uuid.pipe';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import type { AppointmentView } from '../mappers/appointment.mapper';
import { AppointmentsService } from '../services/appointments.service';

@Controller('appointments')
export class AppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}

  @Post()
  @RequirePermission('appointments:appointment:create')
  create(@Body(new ZodValidationPipe(createAppointmentSchema)) body: CreateAppointmentInput): Promise<AppointmentView> {
    return this.appointments.create(body);
  }

  @Get()
  @RequirePermission('appointments:appointment:read')
  list(
    @Query(new ZodValidationPipe(listAppointmentsSchema)) query: ListAppointmentsInput,
    @Query('cursor') cursor: string | undefined,
  ): Promise<Page<AppointmentView>> {
    return this.appointments.list(query, cursor);
  }

  @Get(':id')
  @RequirePermission('appointments:appointment:read')
  get(@Param('id', UuidPipe) id: string): Promise<AppointmentView> {
    return this.appointments.get(id);
  }

  @Patch(':id/reschedule')
  @RequirePermission('appointments:appointment:update')
  reschedule(
    @Param('id', UuidPipe) id: string,
    @Body(new ZodValidationPipe(rescheduleAppointmentSchema)) body: RescheduleAppointmentInput,
  ): Promise<AppointmentView> {
    return this.appointments.reschedule(id, body);
  }

  @Post(':id/status')
  @HttpCode(200)
  @RequirePermission('appointments:appointment:update')
  changeStatus(
    @Param('id', UuidPipe) id: string,
    @Body(new ZodValidationPipe(changeAppointmentStatusSchema)) body: ChangeAppointmentStatusInput,
  ): Promise<AppointmentView> {
    return this.appointments.changeStatus(id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('appointments:appointment:delete')
  remove(@Param('id', UuidPipe) id: string): Promise<void> {
    return this.appointments.remove(id);
  }
}
