import { Injectable } from '@nestjs/common';
import { NOTIFICATION_TYPES, type NotificationChannel } from '@ghmt/shared';
import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { deliveryDeadline } from '../domain/appointment-plan';
import { dedupKey } from '../domain/dedup-key';
import { NotificationsRepository } from '../repositories/notifications.repository';
import { RecipientsRepository } from '../repositories/recipients.repository';

const TYPE_CODE = 'quota.sms_threshold';
const CHANNELS: readonly NotificationChannel[] = NOTIFICATION_TYPES[TYPE_CODE].channels;

export interface QuotaAlertRequest {
  /** `AAAA-MM`. */
  readonly month: string;
  readonly thresholds: readonly number[];
  readonly limit: number;
}

/**
 * Alertes `quota.sms_threshold` aux propriétaires de l'établissement (e-mail et in-app). La clé de déduplication
 * `quota:<AAAA-MM>` + seuil garantit une alerte par mois, par seuil, par destinataire et par canal.
 */
@Injectable()
export class QuotaAlertService {
  constructor(
    private readonly notifications: NotificationsRepository,
    private readonly recipients: RecipientsRepository,
  ) {}

  async ensure(tx: TenantTx, tenantId: string, request: QuotaAlertRequest, now: Date): Promise<void> {
    if (request.thresholds.length === 0) return;
    const owners = await this.recipients.findOwners(tx, tenantId, now, false);
    for (const threshold of request.thresholds) {
      for (const owner of owners) {
        for (const channel of CHANNELS) {
          await this.notifications.insert(tx, tenantId, {
            typeCode: TYPE_CODE,
            category: NOTIFICATION_TYPES[TYPE_CODE].category,
            channel,
            recipientType: 'user',
            recipientId: owner.id,
            subjectType: 'quota',
            subjectId: null,
            subjectVersion: `${request.month}:${threshold}`,
            sourceEventId: null,
            dedupKey: dedupKey({ tenantId, sourceKey: `quota:${request.month}`, typeCode: TYPE_CODE, recipientType: 'user', recipientId: owner.id, channel, variant: String(threshold) }),
            locale: owner.locale === 'en' ? 'en' : 'fr',
            context: { month: request.month, thresholdPercent: threshold, limit: request.limit },
            suppressionReason: null,
            scheduledAt: now,
            deadlineAt: deliveryDeadline({ typeCode: TYPE_CODE, category: 'administrative', channel, scheduledAt: now, startsAt: now }),
          }, now);
        }
      }
    }
  }
}
