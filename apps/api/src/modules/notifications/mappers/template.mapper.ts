import { NOTIFICATION_TYPES, type NotificationChannel, type NotificationLocale, type NotificationTemplateView, type NotificationTypeCode } from '@ghmt/shared';
import type { NotificationTemplate } from '../../../generated/prisma/client';
import type { DefaultTemplate } from '../templates/default-templates';

export interface TemplateKeyParts {
  readonly typeCode: NotificationTypeCode;
  readonly channel: NotificationChannel;
  readonly locale: NotificationLocale;
}

export function customTemplateView(key: TemplateKeyParts, row: NotificationTemplate): NotificationTemplateView {
  return {
    ...key,
    source: 'custom',
    version: row.version,
    subject: row.subject,
    body: row.body,
    variables: NOTIFICATION_TYPES[key.typeCode].variables,
    updatedAt: row.createdAt.toISOString(),
  };
}

export function defaultTemplateView(key: TemplateKeyParts, template: DefaultTemplate): NotificationTemplateView {
  return {
    ...key,
    source: 'default',
    version: template.version,
    subject: template.subject,
    body: template.body,
    variables: NOTIFICATION_TYPES[key.typeCode].variables,
    updatedAt: null,
  };
}
