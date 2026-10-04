import { Injectable, Logger } from '@nestjs/common';
import { DomainEventBus } from '../../../common/events/domain-event-bus';
import type { PaymentSettledPayload } from '../../../common/events/domain-events';
import { formatMoney, moneyEquals, parseMoney } from '../../../common/money/money';
import { Clock } from '../../../common/time/clock';
import { PlatformDb } from '../../../infrastructure/prisma/platform-db.service';
import { ProviderError, type ProviderTransaction } from '../domain/payment-provider';
import { FAILURE_REASONS, REPUBLISH_AFTER_MS } from '../payments.constants';
import { ProviderRegistry } from '../providers/provider-registry';
import { PaymentsRepository, type PaymentAttemptRow } from '../repositories/payments.repository';

export type SettlementOutcome = 'succeeded' | 'failed' | 'cancelled' | 'pending';

/**
 * Règlement des tentatives de paiement : re-vérification auprès du fournisseur, contrôle exact montant + devise,
 * transition idempotente (un seul appelant règle une tentative) puis publication de l'événement de domaine.
 */
@Injectable()
export class PaymentSettlementService {
  private readonly logger = new Logger(PaymentSettlementService.name);

  constructor(
    private readonly db: PlatformDb,
    private readonly repo: PaymentsRepository,
    private readonly providers: ProviderRegistry,
    private readonly bus: DomainEventBus,
    private readonly clock: Clock,
  ) {}

  /** Interroge le fournisseur (source de vérité) et règle la tentative si son état est final. */
  async verifyAndSettle(attempt: PaymentAttemptRow): Promise<SettlementOutcome> {
    if (attempt.status !== 'pending') {
      await this.ensureNotified(attempt);
      return attempt.status as SettlementOutcome;
    }
    const provider = this.providers.get(attempt.provider);
    if (!provider || !attempt.providerReference) throw new ProviderError(attempt.provider, 'Fournisseur indisponible pour cette tentative');
    const remote = await provider.getTransactionStatus(attempt.providerReference);
    await this.db.run((tx) => this.repo.markChecked(tx, attempt.id, this.clock.now()));

    if (remote.status === 'pending') return 'pending';
    if (remote.status === 'failed') return this.settle(attempt, 'failed', FAILURE_REASONS.declined);
    if (!this.matchesAttempt(attempt, remote)) {
      // Succès annoncé pour un autre montant/devise : on ne crédite rien (cas d'alerte, sans valeur dans les logs).
      this.logger.warn({ attemptId: attempt.id, provider: attempt.provider }, 'Paiement réussi mais montant ou devise différents de la tentative');
      return this.settle(attempt, 'failed', FAILURE_REASONS.amountMismatch);
    }
    return this.settle(attempt, 'succeeded', null);
  }

  /** Règle une tentative sans interroger le fournisseur (expiration). */
  async expire(attempt: PaymentAttemptRow): Promise<SettlementOutcome> {
    return this.settle(attempt, 'failed', FAILURE_REASONS.expired);
  }

  /** Marque la tentative comme échouée sans publication (échec de création chez tous les fournisseurs : l'appelant reçoit l'erreur). */
  async failSilently(attemptId: string, reason: string): Promise<void> {
    const now = this.clock.now();
    await this.db.run(async (tx) => {
      await this.repo.settle(tx, attemptId, { status: 'failed', failureReason: reason, at: now });
      await this.repo.markNotified(tx, attemptId, now);
    });
  }

  /**
   * Republie l'événement d'un règlement que les abonnés n'ont pas confirmé (aucune erreur remontée).
   * Un règlement de moins d'une minute est laissé à son gagnant, encore en train de publier.
   */
  async ensureNotified(attempt: PaymentAttemptRow): Promise<void> {
    if (attempt.notifiedAt || attempt.status === 'pending' || attempt.status === 'cancelled') return;
    if (attempt.settledAt && this.clock.now().getTime() - attempt.settledAt.getTime() < REPUBLISH_AFTER_MS) return;
    await this.publish(attempt);
  }

  private async settle(attempt: PaymentAttemptRow, status: 'succeeded' | 'failed', reason: string | null): Promise<SettlementOutcome> {
    const now = this.clock.now();
    const won = await this.db.run((tx) => this.repo.settle(tx, attempt.id, { status, failureReason: reason, at: now }));
    const current = await this.db.run((tx) => this.repo.findById(tx, attempt.id));
    if (!current) return status;
    // Perdre la course n'est pas une erreur : l'état final est celui du gagnant (qui publie).
    if (won) await this.publish(current);
    return current.status as SettlementOutcome;
  }

  private async publish(attempt: PaymentAttemptRow): Promise<void> {
    const payload: PaymentSettledPayload = {
      attemptId: attempt.id,
      purpose: attempt.purpose as PaymentSettledPayload['purpose'],
      tenantId: attempt.tenantId,
      referenceId: attempt.referenceId,
      amount: formatMoney(attempt.amount),
      currency: attempt.currency,
      provider: attempt.provider,
      providerReference: attempt.providerReference,
      settledAt: (attempt.settledAt ?? this.clock.now()).toISOString(),
    };
    try {
      if (attempt.status === 'succeeded') await this.bus.publish('payment.succeeded', payload);
      else await this.bus.publish('payment.failed', { ...payload, reason: attempt.failureReason ?? 'unknown' });
    } catch {
      // Détail déjà journalisé par le bus ; `notified_at` reste vide, le job de relance republiera (abonnés idempotents).
      return;
    }
    await this.db.run((tx) => this.repo.markNotified(tx, attempt.id, this.clock.now()));
  }

  private matchesAttempt(attempt: PaymentAttemptRow, remote: ProviderTransaction): boolean {
    if (remote.amount === null || remote.currency === null || remote.currency !== attempt.currency) return false;
    try {
      return moneyEquals(parseMoney(this.canonicalAmount(remote.amount)), attempt.amount);
    } catch {
      return false;
    }
  }

  /** Les agrégateurs renvoient "15000", "15000.0" ou "15000.00" : forme décimale sans zéros superflus acceptée. */
  private canonicalAmount(raw: string): string {
    const trimmed = raw.trim();
    return /^\d+\.\d*$/.test(trimmed) ? trimmed.replace(/0+$/, '').replace(/\.$/, '') : trimmed;
  }
}
