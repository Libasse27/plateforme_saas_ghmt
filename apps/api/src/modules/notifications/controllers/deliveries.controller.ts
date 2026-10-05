import { Controller, Get, Query } from '@nestjs/common';
import { listDeliveriesQuerySchema, type ListDeliveriesQuery, type NotificationDeliveryView } from '@ghmt/shared';
import { RequirePermission } from '../../../common/decorators/auth.decorators';
import type { Page } from '../../../common/pagination/page';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { DeliveriesService } from '../services/deliveries.service';

@Controller('notifications/deliveries')
export class DeliveriesController {
  constructor(private readonly deliveries: DeliveriesService) {}

  @Get()
  @RequirePermission('settings:notification_log:read')
  list(@Query(new ZodValidationPipe(listDeliveriesQuerySchema)) query: ListDeliveriesQuery): Promise<Page<NotificationDeliveryView>> {
    return this.deliveries.list(query);
  }
}
