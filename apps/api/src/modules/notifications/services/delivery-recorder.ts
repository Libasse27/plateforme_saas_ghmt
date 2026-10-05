import { Injectable } from '@nestjs/common';
import type { SuppressionReason } from '@ghmt/shared';
import type { Notification } from '../../../generated/prisma/client';
import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import type { ClassifiedError, ErrorClass } from '../domain/error-classification';
import { INAPP_TTL_MS } from '../notifications.constants';
import { uuidv7 } from '../domain/uuid-v7';
import type { ComposedMessage } from './message-composer';

const RELEASED = { lockedUntil: null } as const;

export interface SentResult {
  readonly provider: string;
  readonly providerMessageId: string | null;
  readonly recipientMasked: string;
  readonly recipientHashBytes: Buffer;
}

export interface FailureResult {
  readonly kind: 'retry' | 'final';
  readonly error: ClassifiedError | { readonly errorClass: ErrorClass | null; readonly errorCode: string };
  readonly nextAttemptAt?: Date;
}

const toBytes = (buffer: Buffer): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(new ArrayBuffer(buffer.length));
  out.set(buffer);
  return out;
};

/** Écritures de l'état d'une notification (tout dans la transaction fournie). Aucun texte rendu, aucune adresse en clair. */
@Injectable()
export class DeliveryRecorder {
  where(row: Pick<Notification, 'tenantId' | 'id'>): { tenantId_id: { tenantId: string; id: string } } {
    return { tenantId_id: { tenantId: row.tenantId, id: row.id } };
  }

  async suppress(tx: TenantTx, row: Notification, reason: SuppressionReason, now: Date): Promise<void> {
    await tx.notification.update({
      where: this.where(row),
      data: { status: 'suppressed', suppressionReason: reason, suppressedAt: now, segments: null, ...RELEASED, updatedAt: now },
    });
  }

  /** Échec sans tentative d'envoi (échéance dépassée, rendu impossible…). */
  async fail(tx: TenantTx, row: Notification, error: { errorCode: string; errorClass: ErrorClass | null }, now: Date): Promise<void> {
    await tx.notification.update({
      where: this.where(row),
      data: { status: 'failed', failedAt: now, errorCode: error.errorCode, errorClass: error.errorClass, segments: null, ...RELEASED, updatedAt: now },
    });
  }

  /** Report d'envoi (plage silencieuse) ; `deadlineAt` repousse l'échéance d'un message transactionnel reporté. */
  async defer(tx: TenantTx, row: Notification, until: Date, now: Date, deadlineAt?: Date): Promise<void> {
    await tx.notification.update({ where: this.where(row), data: { nextAttemptAt: until, ...(deadlineAt ? { deadlineAt } : {}), ...RELEASED, updatedAt: now } });
  }

  /** Rendu réussi : trace le modèle utilisé et, pour un SMS, les segments réservés au quota. */
  async markPrepared(tx: TenantTx, row: Notification, message: ComposedMessage, now: Date): Promise<void> {
    await tx.notification.update({
      where: this.where(row),
      data: {
        templateSource: message.templateSource,
        templateVersion: message.templateVersion,
        segments: message.sms?.segments ?? null,
        encoding: message.sms?.encoding ?? null,
        updatedAt: now,
      },
    });
  }

  async deliverInApp(tx: TenantTx, row: Notification, content: { title: string; body: string; link: string | null }, now: Date): Promise<void> {
    await tx.inAppMessage.create({
      data: {
        id: uuidv7(),
        tenantId: row.tenantId,
        userId: row.recipientId,
        notificationId: row.id,
        typeCode: row.typeCode,
        title: content.title,
        body: content.body,
        link: content.link,
        createdAt: now,
        expiresAt: new Date(now.getTime() + INAPP_TTL_MS),
      },
    });
    await tx.notification.update({
      where: this.where(row),
      data: { status: 'delivered', sentAt: now, deliveredAt: now, attempts: row.attempts + 1, ...RELEASED, updatedAt: now },
    });
    await this.attempt(tx, row, row.attempts + 1, { outcome: 'delivered', provider: 'inapp' }, now);
  }

  async recordSent(tx: TenantTx, row: Notification, result: SentResult, now: Date): Promise<void> {
    const attempts = row.attempts + 1;
    await tx.notification.update({
      where: this.where(row),
      data: {
        status: 'sent',
        sentAt: now,
        attempts,
        provider: result.provider,
        providerMessageId: result.providerMessageId,
        recipientMasked: result.recipientMasked,
        recipientHash: toBytes(result.recipientHashBytes),
        errorClass: null,
        errorCode: null,
        ...RELEASED,
        updatedAt: now,
      },
    });
    await this.attempt(tx, row, attempts, { outcome: 'sent', provider: result.provider, providerMessageId: result.providerMessageId }, now);
  }

  /** Échec d'un envoi : nouvel essai programmé (la réservation de segments est libérée) ou échec définitif. */
  async recordFailure(tx: TenantTx, row: Notification, failure: FailureResult, provider: string | null, now: Date): Promise<void> {
    const attempts = row.attempts + 1;
    const retry = failure.kind === 'retry' && failure.nextAttemptAt !== undefined;
    await tx.notification.update({
      where: this.where(row),
      data: {
        attempts,
        errorClass: failure.error.errorClass,
        errorCode: failure.error.errorCode,
        segments: null,
        ...RELEASED,
        updatedAt: now,
        ...(retry ? { nextAttemptAt: failure.nextAttemptAt } : { status: 'failed', failedAt: now }),
      },
    });
    await this.attempt(tx, row, attempts, { outcome: retry ? 'retry_scheduled' : 'failed', provider, error: failure.error }, now);
  }

  async recordDelivery(tx: TenantTx, row: Notification, outcome: 'delivered' | 'failed', error: { errorClass: ErrorClass; errorCode: string } | null, now: Date): Promise<void> {
    await tx.notification.update({
      where: this.where(row),
      data: outcome === 'delivered' ? { status: 'delivered', deliveredAt: now, updatedAt: now } : { status: 'failed', failedAt: now, errorClass: error?.errorClass ?? null, errorCode: error?.errorCode ?? null, updatedAt: now },
    });
    await this.attempt(tx, row, row.attempts, { outcome, provider: row.provider, providerMessageId: row.providerMessageId, error }, now);
  }

  private async attempt(
    tx: TenantTx,
    row: Notification,
    attempt: number,
    detail: {
      outcome: 'sent' | 'delivered' | 'failed' | 'retry_scheduled';
      provider: string | null;
      providerMessageId?: string | null;
      error?: { errorClass: ErrorClass | null; errorCode: string } | null;
    },
    now: Date,
  ): Promise<void> {
    await tx.notificationAttempt.create({
      data: {
        id: uuidv7(),
        tenantId: row.tenantId,
        notificationId: row.id,
        attempt,
        outcome: detail.outcome,
        provider: detail.provider,
        providerMessageId: detail.providerMessageId ?? null,
        errorClass: detail.error?.errorClass ?? null,
        errorCode: detail.error?.errorCode ?? null,
        occurredAt: now,
      },
    });
  }
}
