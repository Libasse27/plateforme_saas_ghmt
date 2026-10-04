import { Body, Controller, Headers, HttpCode, Param, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { sandboxSimulationSchema, type SandboxSimulationInput } from '@ghmt/shared';
import { Public } from '../../../common/decorators/auth.decorators';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import type { WebhookHeaders } from '../domain/payment-provider';
import { WEBHOOK_THROTTLE } from '../payments.constants';
import { SandboxSimulationService } from '../services/sandbox-simulation.service';
import { WebhookService, type WebhookResult } from '../services/webhook.service';
import { readRawBody } from './raw-body';

/** Webhooks des agrégateurs : hors tenant, sans authentification (l'authenticité repose sur la signature), débit limité. */
@Controller('webhooks/payments')
export class WebhooksController {
  constructor(
    private readonly webhooks: WebhookService,
    private readonly simulation: SandboxSimulationService,
  ) {}

  /** Désactivé en production (le fournisseur sandbox n'y existe pas). */
  @Post('sandbox/simulate')
  @Public()
  @HttpCode(200)
  @Throttle(WEBHOOK_THROTTLE)
  simulate(@Body(new ZodValidationPipe(sandboxSimulationSchema)) body: SandboxSimulationInput): Promise<WebhookResult> {
    return this.simulation.simulate(body);
  }

  @Post(':provider')
  @Public()
  @HttpCode(200)
  @Throttle(WEBHOOK_THROTTLE)
  async receive(@Param('provider') provider: string, @Headers() headers: WebhookHeaders, @Req() req: Request): Promise<WebhookResult> {
    return this.webhooks.handle(provider, headers, await readRawBody(req));
  }
}
