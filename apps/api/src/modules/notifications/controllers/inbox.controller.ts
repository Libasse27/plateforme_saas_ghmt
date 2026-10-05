import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import {
  listInboxQuerySchema,
  updateNotificationPreferencesSchema,
  type InAppMessageView,
  type ListInboxQuery,
  type NotificationPreferenceView,
  type UnreadCountView,
  type UpdateNotificationPreferencesInput,
} from '@ghmt/shared';
import { AuthenticatedOnly } from '../../../common/decorators/auth.decorators';
import type { Page } from '../../../common/pagination/page';
import { UuidPipe } from '../../../common/pipes/uuid.pipe';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { InboxService } from '../services/inbox.service';
import { PreferencesService } from '../services/preferences.service';

/** Boîte in-app et préférences personnelles : tout utilisateur authentifié, sur ses propres données (docs/10 §5.1, §5.2). */
@Controller('notifications')
@AuthenticatedOnly()
export class InboxController {
  constructor(
    private readonly inbox: InboxService,
    private readonly preferences: PreferencesService,
  ) {}

  @Get('inbox')
  list(@Query(new ZodValidationPipe(listInboxQuerySchema)) query: ListInboxQuery): Promise<Page<InAppMessageView>> {
    return this.inbox.list(query);
  }

  @Get('inbox/unread-count')
  unreadCount(): Promise<UnreadCountView> {
    return this.inbox.unreadCount();
  }

  @Post('inbox/read-all')
  @HttpCode(200)
  readAll(): Promise<{ updated: number }> {
    return this.inbox.markAllRead();
  }

  @Post('inbox/:id/read')
  @HttpCode(200)
  read(@Param('id', UuidPipe) id: string): Promise<InAppMessageView> {
    return this.inbox.markRead(id);
  }

  @Get('preferences')
  getPreferences(): Promise<{ items: NotificationPreferenceView[] }> {
    return this.preferences.get();
  }

  @Put('preferences')
  updatePreferences(@Body(new ZodValidationPipe(updateNotificationPreferencesSchema)) body: UpdateNotificationPreferencesInput): Promise<{ items: NotificationPreferenceView[] }> {
    return this.preferences.update(body);
  }
}
