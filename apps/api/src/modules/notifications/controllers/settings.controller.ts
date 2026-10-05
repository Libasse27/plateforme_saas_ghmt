import { Body, Controller, Get, Put } from '@nestjs/common';
import { updateNotificationSettingsSchema, type NotificationSettingsView, type UpdateNotificationSettingsInput } from '@ghmt/shared';
import { RequirePermission } from '../../../common/decorators/auth.decorators';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { SettingsService } from '../services/settings.service';

@Controller('notifications/settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @RequirePermission('settings:notification_template:read')
  get(): Promise<NotificationSettingsView> {
    return this.settings.get();
  }

  @Put()
  @RequirePermission('settings:notification_template:update')
  update(@Body(new ZodValidationPipe(updateNotificationSettingsSchema)) body: UpdateNotificationSettingsInput): Promise<NotificationSettingsView> {
    return this.settings.update(body);
  }
}
