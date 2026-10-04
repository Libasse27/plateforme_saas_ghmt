import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { SandboxSimulationInput } from '@ghmt/shared';
import { DomainError } from '../../../common/errors/domain-error';
import { PlatformDb } from '../../../infrastructure/prisma/platform-db.service';
import { ProviderRegistry } from '../providers/provider-registry';
import { SANDBOX_CODE, SANDBOX_SIGNATURE_HEADER, SandboxProvider } from '../providers/sandbox.provider';
import { PaymentsRepository } from '../repositories/payments.repository';
import { WebhookService, type WebhookResult } from './webhook.service';

/**
 * Simule l'action de l'utilisateur chez l'agrégateur (validation sur son téléphone) puis fait émettre au sandbox
 * un webhook signé, traité par le pipeline normal. Désactivé (404) tant que le fournisseur sandbox n'est pas actif.
 */
@Injectable()
export class SandboxSimulationService {
  constructor(
    private readonly db: PlatformDb,
    private readonly repo: PaymentsRepository,
    private readonly providers: ProviderRegistry,
    private readonly webhooks: WebhookService,
  ) {}

  async simulate(input: SandboxSimulationInput): Promise<WebhookResult> {
    const sandbox = this.providers.getEnabled(SANDBOX_CODE);
    if (!(sandbox instanceof SandboxProvider)) throw DomainError.notFound();

    const attempt = await this.db.run((tx) =>
      input.attemptId
        ? this.repo.findById(tx, input.attemptId)
        : this.repo.findByProviderReference(tx, SANDBOX_CODE, input.providerReference ?? ''),
    );
    if (!attempt || attempt.provider !== SANDBOX_CODE || !attempt.providerReference) throw DomainError.notFound('Tentative de paiement');

    const status = input.outcome === 'success' ? 'succeeded' : 'failed';
    await sandbox.completeRemote(attempt.providerReference, status);
    const rawBody = Buffer.from(JSON.stringify({ eventId: randomUUID(), providerReference: attempt.providerReference, status }));
    return this.webhooks.handle(SANDBOX_CODE, { [SANDBOX_SIGNATURE_HEADER]: sandbox.sign(rawBody) }, rawBody);
  }
}
