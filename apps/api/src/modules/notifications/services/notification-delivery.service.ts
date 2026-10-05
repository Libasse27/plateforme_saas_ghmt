import { Inject, Injectable, Logger } from '@nestjs/common';
import type { NotificationChannel } from '@ghmt/shared';
import type { Notification } from '../../../generated/prisma/client';
import { ENV, type Env } from '../../../infrastructure/config/env';
import { PlatformDb } from '../../../infrastructure/prisma/platform-db.service';
import { TenantDb } from '../../../infrastructure/prisma/tenant-db.service';
import { decideAfterFailure } from '../domain/retry-policy';
import { LEASE_MS, MAX_BATCHES_PER_TICK } from '../notifications.constants';
import { NotificationsRepository } from '../repositories/notifications.repository';
import { ChannelSender, type PreparedSend, type SendOutcome } from './channel-sender';
import { DeliveryPreparer } from './delivery-preparer';
import { DeliveryRecorder, type FailureResult } from './delivery-recorder';
import { SmsRecipientRegistry } from './sms-recipient-registry';

export interface DeliveryReport {
  readonly processed: number;
}

/**
 * Envoi des notifications d'un établissement (docs/10 §5.8) : (a) réservation avec bail, (b) préparation en transaction,
 * (c) appel du fournisseur HORS transaction, (d) transaction de résultat. Un échec inattendu sur une ligne est enregistré
 * comme erreur transitoire et ne bloque pas le reste du lot. Les journaux ne portent que des identifiants et des codes.
 */
@Injectable()
export class NotificationDeliveryService {
  private readonly logger = new Logger(NotificationDeliveryService.name);

  constructor(
    private readonly db: TenantDb,
    private readonly platformDb: PlatformDb,
    private readonly notifications: NotificationsRepository,
    private readonly preparer: DeliveryPreparer,
    private readonly sender: ChannelSender,
    private readonly recorder: DeliveryRecorder,
    private readonly registry: SmsRecipientRegistry,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async deliverTenant(tenantId: string, now: Date): Promise<DeliveryReport> {
    let processed = 0;
    for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch += 1) {
      const rows = await this.db.runAs(tenantId, (tx) =>
        this.notifications.reserveDue(tx, tenantId, now, this.env.NOTIFICATIONS_BATCH_SIZE, new Date(now.getTime() + LEASE_MS)),
      );
      if (rows.length === 0) break;
      for (const row of rows) await this.deliverSafely(tenantId, row, now);
      processed += rows.length;
    }
    return { processed };
  }

  private async deliverSafely(tenantId: string, row: Notification, now: Date): Promise<void> {
    try {
      await this.deliverOne(tenantId, row, now);
    } catch (error: unknown) {
      this.logger.error({ notificationId: row.id, typeCode: row.typeCode, channel: row.channel, errorClass: 'transient', errorCode: errorName(error) }, 'Échec inattendu du traitement d’une notification');
      await this.recordUnexpected(tenantId, row, now);
    }
  }

  private async deliverOne(tenantId: string, row: Notification, now: Date): Promise<void> {
    if (row.subjectType === 'saas_invoice' && !(await this.isInvoiceOpen(row))) {
      await this.db.runAs(tenantId, (tx) => this.recorder.suppress(tx, row, 'invoice_settled', now));
      return;
    }
    const prepared = await this.db.runAs(tenantId, (tx) => this.preparer.prepare(tx, row, now));
    if (!prepared) return;
    const outcome = await this.sender.send(prepared);
    await this.db.runAs(tenantId, (tx) => this.recordOutcome(tx, row, outcome, now));
    if (outcome.ok && prepared.channel === 'sms') await this.rememberRecipient(prepared, outcome, now);
    this.logger.debug({ notificationId: row.id, typeCode: row.typeCode, channel: row.channel, status: outcome.ok ? 'sent' : 'error' }, 'Notification traitée');
  }

  /** La facture doit être `open` à la création ET à l'envoi (docs/10 D15). */
  private async isInvoiceOpen(row: Notification): Promise<boolean> {
    const invoice = await this.platformDb.run((tx) => tx.saasInvoice.findUnique({ where: { id: row.subjectId as string }, select: { status: true } }));
    return invoice?.status === 'open';
  }

  private async recordOutcome(tx: Parameters<DeliveryRecorder['recordSent']>[0], row: Notification, outcome: SendOutcome, now: Date): Promise<void> {
    if (outcome.ok) return this.recorder.recordSent(tx, row, outcome.result, now);
    await this.recorder.recordFailure(tx, row, this.failureOf(row, outcome, now), outcome.provider, now);
    this.logger.warn(
      { notificationId: row.id, typeCode: row.typeCode, channel: row.channel, status: 'failure', errorClass: outcome.error.errorClass, errorCode: outcome.error.errorCode },
      'Échec d’envoi',
    );
  }

  /** Erreur permanente : échec immédiat. Erreur transitoire : nouvel essai avec backoff, jusqu'au maximum ou à l'échéance. */
  private failureOf(row: Notification, outcome: Extract<SendOutcome, { ok: false }>, now: Date): FailureResult {
    if (outcome.error.errorClass !== 'transient') return { kind: 'final', error: outcome.error };
    const decision = decideAfterFailure({ channel: row.channel as NotificationChannel, attempts: row.attempts + 1, now, deadlineAt: row.deadlineAt, seed: row.id });
    if (decision.kind === 'retry') return { kind: 'retry', error: outcome.error, nextAttemptAt: decision.nextAttemptAt };
    return { kind: 'final', error: { errorClass: outcome.error.errorClass, errorCode: decision.errorCode } };
  }

  private async rememberRecipient(prepared: PreparedSend, outcome: Extract<SendOutcome, { ok: true }>, now: Date): Promise<void> {
    try {
      await this.registry.touch(outcome.result.recipientHashBytes, prepared.tenantId, now);
    } catch (error: unknown) {
      this.logger.warn({ notificationId: prepared.notificationId, errorCode: errorName(error) }, 'Enregistrement du routage STOP impossible');
    }
  }

  private async recordUnexpected(tenantId: string, row: Notification, now: Date): Promise<void> {
    try {
      const outcome = { ok: false, error: { errorClass: 'transient', errorCode: 'internal_error' }, provider: 'internal' } as const;
      await this.db.runAs(tenantId, async (tx) => {
        const fresh = (await this.notifications.findById(tx, tenantId, row.id)) ?? row;
        await this.recordOutcome(tx, fresh, outcome, now);
      });
    } catch {
      // Le bail expirera et la ligne sera reprise : on ne masque pas l'erreur d'origine, déjà journalisée.
    }
  }
}

const errorName = (error: unknown): string => (error instanceof Error ? error.name.slice(0, 50) : 'unknown');
