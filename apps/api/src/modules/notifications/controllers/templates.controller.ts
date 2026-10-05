import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import {
  listNotificationTemplatesQuerySchema,
  previewNotificationTemplateSchema,
  upsertNotificationTemplateSchema,
  type ListNotificationTemplatesQuery,
  type NotificationTemplateView,
  type PreviewNotificationTemplateInput,
  type TemplatePreviewView,
  type UpsertNotificationTemplateInput,
} from '@ghmt/shared';
import { RequirePermission } from '../../../common/decorators/auth.decorators';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { TemplatesService } from '../services/templates.service';

@Controller('notifications/templates')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  @RequirePermission('settings:notification_template:read')
  list(@Query(new ZodValidationPipe(listNotificationTemplatesQuerySchema)) query: ListNotificationTemplatesQuery): Promise<NotificationTemplateView[]> {
    return this.templates.list(query.typeCode);
  }

  @Post('preview')
  @HttpCode(200)
  @RequirePermission('settings:notification_template:read')
  preview(@Body(new ZodValidationPipe(previewNotificationTemplateSchema)) body: PreviewNotificationTemplateInput): Promise<TemplatePreviewView> {
    return this.templates.preview(body);
  }

  @Put(':typeCode/:channel/:locale')
  @RequirePermission('settings:notification_template:update')
  upsert(
    @Param('typeCode') typeCode: string,
    @Param('channel') channel: string,
    @Param('locale') locale: string,
    @Body(new ZodValidationPipe(upsertNotificationTemplateSchema)) body: UpsertNotificationTemplateInput,
  ): Promise<NotificationTemplateView> {
    return this.templates.upsert(typeCode, channel, locale, body);
  }

  @Delete(':typeCode/:channel/:locale')
  @HttpCode(204)
  @RequirePermission('settings:notification_template:update')
  remove(@Param('typeCode') typeCode: string, @Param('channel') channel: string, @Param('locale') locale: string): Promise<void> {
    return this.templates.remove(typeCode, channel, locale);
  }
}
