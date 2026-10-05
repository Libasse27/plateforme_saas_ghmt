import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SmsDeliveryWebhookInput, SmsInboundWebhookInput } from '@ghmt/shared';
import { DomainError } from '../../../common/errors/domain-error';
import { Clock } from '../../../common/time/clock';
import { ENV, type Env } from '../../../infrastructure/config/env';
import { TenantDb } from '../../../infrastructure/prisma/tenant-db.service';
import { hmacSha256Hex, safeEqualHex } from '../../payments/domain/webhook-signature';
import { isStopMessage } from '../domain/stop-keyword';
import { SIGNATURE_TOLERANCE_SECONDS } from '../notifications.constants';
import { NotificationsRepository } from '../repositories/notifications.repository';
import { DeliveryRecorder } from './delivery-recorder';
import { SmsStopService } from './sms-stop.service';

export interface SmsWebhookHeaders {
  readonly timestamp: string | undefined;
  readonly signature: string | undefined;
}

const notFound = (): DomainError => DomainError.notFound();
const invalidSignature = (): DomainError => new DomainError('invalid_signature', 401, 'Unauthorized', 'Signature invalide.');

/**
 * Webhooks SMS (docs/10 §5.7) : accusés de réception et messages entrants. L'adaptateur `http` est authentifié par HMAC
 * (`x-ghmt-timestamp` ± 300 s, `x-ghmt-signature = hex(HMAC(secret, "<timestamp>.<corps brut>"))`, temps constant) ; le
 * sandbox n'a aucune signature et n'existe que si `SMS_PROVIDER=sandbox`. Un `clientRef` inconnu ne révèle rien (204).
 */
@Injectable()
export class SmsWebhookService {
  private readonly logger = new Logger(SmsWebhookService.name);

  constructor(
    private readonly db: TenantDb,
    private readonly notifications: NotificationsRepository,
    private readonly recorder: DeliveryRecorder,
    private readonly stop: SmsStopService,
    private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Routes `sandbox/*` : 404 sauf si le fournisseur actif est le sandbox. */
  assertSandbox(): void {
    if (this.env.SMS_PROVIDER !== 'sandbox') throw notFound();
  }

  /** Routes `http/*` : 404 si l'adaptateur ou le secret manquent, 401 si la signature ou l'horodatage sont invalides. */
  assertSignedHttp(headers: SmsWebhookHeaders, rawBody: Buffer): void {
    const secret = this.env.SMS_HTTP_WEBHOOK_SECRET;
    if (this.env.SMS_PROVIDER !== 'http' || !secret) throw notFound();
    const timestamp = headers.timestamp !== undefined && /^\d{1,12}$/.test(headers.timestamp) ? Number(headers.timestamp) : null;
    if (timestamp === null || !headers.signature) throw invalidSignature();
    const nowSeconds = Math.floor(this.clock.now().getTime() / 1000);
    if (Math.abs(nowSeconds - timestamp) > SIGNATURE_TOLERANCE_SECONDS) throw invalidSignature();
    const expected = hmacSha256Hex(secret, `${timestamp}.${rawBody.toString('utf8')}`);
    if (!safeEqualHex(headers.signature, expected)) throw invalidSignature();
  }

  /** `delivered` ⇒ delivered ; `undeliverable` ou `failed` ⇒ failed (permanent_recipient). Idempotent : seul `sent` évolue. */
  async handleDelivery(input: SmsDeliveryWebhookInput): Promise<void> {
    const [tenantId, notificationId] = input.clientRef.split('.') as [string, string];
    const now = this.clock.now();
    await this.db.runAs(tenantId, async (tx) => {
      const row = await this.notifications.findById(tx, tenantId, notificationId);
      if (!row || row.channel !== 'sms' || row.status !== 'sent') return;
      if (input.providerMessageId && row.providerMessageId && input.providerMessageId !== row.providerMessageId) return;
      if (input.status === 'delivered') return this.recorder.recordDelivery(tx, row, 'delivered', null, now);
      await this.recorder.recordDelivery(tx, row, 'failed', { errorClass: 'permanent_recipient', errorCode: input.errorCode ?? input.status }, now);
    });
  }

  /** Message entrant : seul un STOP a un effet ; tout autre texte est ignoré (jamais journalisé). */
  async handleInbound(input: SmsInboundWebhookInput): Promise<void> {
    if (!isStopMessage(input.text)) return;
    const revoked = await this.stop.revokeEverywhere(input.from, this.clock.now());
    this.logger.log({ tenants: revoked }, 'STOP SMS traité');
  }
}
