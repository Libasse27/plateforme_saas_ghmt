import { Injectable } from '@nestjs/common';
import type { NotificationPreferenceView, UpdateNotificationPreferencesInput } from '@ghmt/shared';
import { AuditService } from '../../../common/audit/audit.service';
import { RequestContext } from '../../../common/context/request-context';
import { DomainError, type FieldIssue } from '../../../common/errors/domain-error';
import { TenantDb } from '../../../infrastructure/prisma/tenant-db.service';
import { toPreferenceViews } from '../mappers/inapp.mapper';
import { RecipientsRepository } from '../repositories/recipients.repository';

const LOCKED_ISSUE = (index: number): FieldIssue => ({
  path: `items.${index}`,
  code: 'preference_locked',
  message: 'Cette préférence est verrouillée : les notifications dans l’application restent toujours actives.',
});

/** Préférences de notification de l'utilisateur connecté (docs/10 §5.2). */
@Injectable()
export class PreferencesService {
  constructor(
    private readonly db: TenantDb,
    private readonly recipients: RecipientsRepository,
    private readonly audit: AuditService,
    private readonly context: RequestContext,
  ) {}

  get(): Promise<{ items: NotificationPreferenceView[] }> {
    const { tenantId, userId } = this.context.requirePrincipal();
    return this.db.run(async (tx) => ({ items: toPreferenceViews(await this.recipients.isEmailEnabled(tx, tenantId, userId)) }));
  }

  update(input: UpdateNotificationPreferencesInput): Promise<{ items: NotificationPreferenceView[] }> {
    const { tenantId, userId } = this.context.requirePrincipal();
    const locked = input.items.flatMap((item, index) => (item.channel === 'inapp' && !item.enabled ? [LOCKED_ISSUE(index)] : []));
    if (locked.length > 0) {
      throw new DomainError('preference_locked', 422, 'Unprocessable Entity', 'Une préférence verrouillée ne peut pas être désactivée.', { errors: locked });
    }
    return this.db.run(async (tx) => {
      for (const item of input.items.filter((candidate) => candidate.channel === 'email')) {
        const key = { tenantId, userId, category: item.category, channel: item.channel };
        await tx.notificationPreference.upsert({
          where: { tenantId_userId_category_channel: key },
          create: { ...key, enabled: item.enabled },
          update: { enabled: item.enabled, updatedAt: new Date() },
        });
      }
      await this.audit.record(tx, tenantId, {
        action: 'notification.preferences_updated',
        resourceType: 'notification_preference',
        resourceId: userId,
        changes: { items: input.items.map(({ category, channel, enabled }) => ({ category, channel, enabled })) },
      });
      return { items: toPreferenceViews(await this.recipients.isEmailEnabled(tx, tenantId, userId)) };
    });
  }
}
