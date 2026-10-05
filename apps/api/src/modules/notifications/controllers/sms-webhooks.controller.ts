import { Controller, Headers, HttpCode, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { smsDeliveryWebhookSchema, smsInboundWebhookSchema } from '@ghmt/shared';
import { Public } from '../../../common/decorators/auth.decorators';
import { DomainError } from '../../../common/errors/domain-error';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { readRawBody } from '../../payments/controllers/raw-body';
import { WEBHOOK_BODY_LIMIT_BYTES, WEBHOOK_THROTTLE } from '../notifications.constants';
import { SmsWebhookService } from '../services/sms-webhook.service';

const deliveryPipe = new ZodValidationPipe(smsDeliveryWebhookSchema);
const inboundPipe = new ZodValidationPipe(smsInboundWebhookSchema);

const bodyOf = (req: Request): unknown => (req as Request & { body?: unknown }).body;

/** Corps brut (celui de la signature), borné à 64 Ko. Contrôlé AVANT la validation du contenu : un corps trop gros est un 413, jamais un 422. */
async function boundedRawBody(req: Request): Promise<Buffer> {
  const raw = await readRawBody(req);
  if (raw.length > WEBHOOK_BODY_LIMIT_BYTES) throw new DomainError('payload_too_large', 413, 'Payload Too Large', 'Corps de requête trop volumineux.');
  return raw;
}

/** Webhooks des fournisseurs SMS : publics (l'authenticité repose sur la signature), débit limité à 60 requêtes/min/IP. */
@Controller('webhooks/sms')
@Public()
@Throttle(WEBHOOK_THROTTLE)
export class SmsWebhooksController {
  constructor(private readonly webhooks: SmsWebhookService) {}

  @Post('http/delivery')
  @HttpCode(204)
  async httpDelivery(@Req() req: Request, @Headers('x-ghmt-timestamp') timestamp: string | undefined, @Headers('x-ghmt-signature') signature: string | undefined): Promise<void> {
    this.webhooks.assertSignedHttp({ timestamp, signature }, await boundedRawBody(req));
    await this.webhooks.handleDelivery(deliveryPipe.transform(bodyOf(req)));
  }

  @Post('http/inbound')
  @HttpCode(204)
  async httpInbound(@Req() req: Request, @Headers('x-ghmt-timestamp') timestamp: string | undefined, @Headers('x-ghmt-signature') signature: string | undefined): Promise<void> {
    this.webhooks.assertSignedHttp({ timestamp, signature }, await boundedRawBody(req));
    await this.webhooks.handleInbound(inboundPipe.transform(bodyOf(req)));
  }

  @Post('sandbox/delivery')
  @HttpCode(204)
  async sandboxDelivery(@Req() req: Request): Promise<void> {
    this.webhooks.assertSandbox();
    await boundedRawBody(req);
    await this.webhooks.handleDelivery(deliveryPipe.transform(bodyOf(req)));
  }

  @Post('sandbox/inbound')
  @HttpCode(204)
  async sandboxInbound(@Req() req: Request): Promise<void> {
    this.webhooks.assertSandbox();
    await boundedRawBody(req);
    await this.webhooks.handleInbound(inboundPipe.transform(bodyOf(req)));
  }
}
