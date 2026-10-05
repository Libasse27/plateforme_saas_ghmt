import { z } from 'zod';
import type { TenantTx } from '../../infrastructure/prisma/tenant-db.service';

export type OutboxEventType = 'appointment.created' | 'appointment.rescheduled' | 'appointment.cancelled' | 'appointment.deleted';

const isoInstant = z.iso.datetime({ offset: true });

/**
 * Charge utile d'un événement d'outbox : des dates seulement. `strict` refuse toute autre clé, pour qu'aucune donnée
 * de santé (motif, nom…) ne puisse y être glissée par erreur (docs/10 D6, D7).
 */
export const outboxPayloadSchema = z.object({ startsAt: isoInstant, previousStartsAt: isoInstant.optional() }).strict();
export type OutboxPayload = z.infer<typeof outboxPayloadSchema>;

export interface OutboxEventInput {
  readonly eventType: OutboxEventType;
  /** Identifiant du rendez-vous. */
  readonly aggregateId: string;
  readonly payload: OutboxPayload;
}

/**
 * Écrit un événement dans `tenant.notification_outbox`, DANS la transaction métier de l'appelant (docs/10 D7) : pas
 * d'événement sans l'action, pas d'action sans événement, et aucune double écriture base/file. Fonction pure : elle
 * n'ouvre aucune transaction. Une charge utile invalide lève une erreur (annulant la transaction de l'appelant).
 */
export async function enqueueOutboxEvent(tx: TenantTx, tenantId: string, event: OutboxEventInput): Promise<void> {
  const payload = outboxPayloadSchema.parse(event.payload);
  await tx.notificationOutboxEvent.create({
    data: { tenantId, eventType: event.eventType, aggregateType: 'appointment', aggregateId: event.aggregateId, payload },
  });
}
