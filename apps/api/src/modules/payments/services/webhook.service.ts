import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PaymentProviderUnavailableError } from '../../../common/payments/payments-gateway';
import { DomainError } from '../../../common/errors/domain-error';
import { Clock } from '../../../common/time/clock';
import { PlatformDb } from '../../../infrastructure/prisma/platform-db.service';
import { ProviderError, type PaymentProvider, type WebhookHeaders } from '../domain/payment-provider';
import { ProviderRegistry } from '../providers/provider-registry';
import { PaymentsRepository, type PaymentEventRow } from '../repositories/payments.repository';
import { PaymentSettlementService, type SettlementOutcome } from './payment-settlement.service';

export type WebhookOutcome = SettlementOutcome | 'duplicate' | 'unknown_reference';

export interface WebhookResult {
  readonly received: true;
  readonly outcome: WebhookOutcome;
}

const UNAUTHORIZED = 401;

/**
 * Réception d'un webhook de paiement (docs/05 A9) :
 * signature en temps constant → stockage de l'événement brut (idempotent) → re-vérification serveur à serveur
 * → contrôle montant/devise → transition idempotente → publication de l'événement de domaine.
 */
@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    private readonly db: PlatformDb,
    private readonly repo: PaymentsRepository,
    private readonly providers: ProviderRegistry,
    private readonly settlement: PaymentSettlementService,
    private readonly clock: Clock,
  ) {}

  async handle(providerCode: string, headers: WebhookHeaders, rawBody: Buffer): Promise<WebhookResult> {
    const provider = this.providers.getEnabled(providerCode);
    if (!provider) throw DomainError.notFound('Fournisseur de paiement');

    const verification = provider.verifyWebhook(headers, rawBody);
    if (!verification.valid) {
      // Jamais le corps ni les en-têtes : seuls le fournisseur et le constat d'échec sont journalisés.
      this.logger.warn({ provider: provider.code }, 'Webhook de paiement rejeté : signature invalide');
      throw new DomainError('invalid_webhook_signature', UNAUTHORIZED, 'Unauthorized', 'Signature invalide.');
    }

    const event = await this.storeEvent(provider, verification.eventId, verification.providerReference, rawBody);
    if (event.processedAt) return { received: true, outcome: 'duplicate' };

    const attempt = await this.db.run((tx) => this.repo.findByProviderReference(tx, provider.code, verification.providerReference));
    if (!attempt) {
      await this.complete(event, null, 'unknown_reference');
      return { received: true, outcome: 'unknown_reference' };
    }
    let outcome: SettlementOutcome;
    try {
      outcome = await this.settlement.verifyAndSettle(attempt);
    } catch (error: unknown) {
      if (!(error instanceof ProviderError)) throw error;
      // Re-vérification impossible : l'événement reste « non traité » ; le fournisseur (ou le job) rejouera.
      this.logger.warn({ attemptId: attempt.id, provider: provider.code }, 'Re-vérification impossible lors d’un webhook');
      throw new PaymentProviderUnavailableError(attempt.id, true);
    }
    await this.complete(event, attempt.id, outcome);
    return { received: true, outcome };
  }

  /**
   * Stocke l'événement EXPURGÉ (téléphone et identifiants du payeur retirés) avec l'empreinte SHA-256 du corps brut :
   * un rejeu strict du même corps est reconnu par son empreinte, un rejeu du même identifiant d'événement par sa clé unique.
   */
  private async storeEvent(provider: PaymentProvider, eventId: string, providerReference: string, rawBody: Buffer): Promise<PaymentEventRow> {
    const bodySha256 = createHash('sha256').update(rawBody).digest('hex');
    return this.db.run(async (tx) => {
      const replay = await this.repo.findEventByBodyHash(tx, provider.code, bodySha256);
      if (replay) return replay;
      const inserted = await this.repo.insertEvent(tx, {
        provider: provider.code,
        providerEventId: eventId,
        providerReference,
        rawBody: provider.redactWebhookBody(rawBody),
        bodySha256,
      });
      if (inserted) return inserted;
      const existing = await this.repo.findEvent(tx, provider.code, eventId);
      if (!existing) throw new Error('Événement de paiement introuvable après conflit');
      return existing;
    });
  }

  private complete(event: PaymentEventRow, attemptId: string | null, outcome: string): Promise<void> {
    return this.db.run((tx) => this.repo.completeEvent(tx, event.id, { attemptId, outcome, at: this.clock.now() }));
  }
}
