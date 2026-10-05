import type { NotificationChannel, NotificationDeliveryView, NotificationStatus, SuppressionReason } from '@ghmt/shared';
import type { Notification } from '../../../generated/prisma/client';

/** Vue du journal : jamais d'identifiant de destinataire, d'empreinte, de clé de déduplication, de contexte ni de texte. */
export function toDeliveryView(row: Notification): NotificationDeliveryView {
  return {
    id: row.id,
    typeCode: row.typeCode,
    channel: row.channel as NotificationChannel,
    status: row.status as NotificationStatus,
    suppressionReason: row.suppressionReason as SuppressionReason | null,
    recipientType: row.recipientType as 'user' | 'patient',
    recipientMasked: row.recipientMasked,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    attempts: row.attempts,
    errorClass: row.errorClass,
    errorCode: row.errorCode,
    provider: row.provider,
    createdAt: row.createdAt.toISOString(),
    scheduledAt: row.scheduledAt.toISOString(),
    sentAt: row.sentAt?.toISOString() ?? null,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
  };
}
