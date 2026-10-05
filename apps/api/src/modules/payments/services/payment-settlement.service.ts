import { Injectable, Logger } from '@nestjs/common';
import { PlatformAuditService } from '../../../common/audit/platform-audit.service';
import { DomainEventBus } from '../../../common/events/domain-event-bus';
import type { PaymentSettledPayload } from '../../../common/events/domain-events';
import { formatMoney, moneyEquals, parseMoney } from '../../../common/money/money';
import { Clock } from '../../../common/time/clock';
import { PlatformDb, type PlatformTx } from '../../../infrastructure/prisma/platform-db.service';
import { ProviderError, type ProviderTransaction } from '../domain/payment-provider';
import { FAILURE_REASONS, REPUBLISH_AFTER_MS } from '../payments.constants';
import { ProviderRegistry } from '../providers/provider-registry';
import { LATE_SUCCESS_REASONS, PaymentsRepository, type PaymentAttemptRow } from '../repositories/payments.repository';

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
    private readonly audit: PlatformAuditService,
    private readonly clock: Clock,
  ) {}

  /** Interroge le fournisseur (source de vérité) et règle la tentative si son état est final. */
  async verifyAndSettle(attempt: PaymentAttemptRow): Promise<SettlementOutcome> {
    if (attempt.status !== 'pending') {
      if (this.mayStillSucceed(attempt)) return this.recheckLate(attempt);
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
      await this.alertMismatch(attempt, remote);
      return this.settle(attempt, 'failed', FAILURE_REASONS.amountMismatch);
    }
    return this.settle(attempt, 'succeeded', null);
  }

  /** Une tentative expirée, abandonnée ou sans réponse peut encore être payée : elle reste vérifiable (succès tardif). */
  private mayStillSucceed(attempt: PaymentAttemptRow): boolean {
    return (attempt.status === 'failed' || attempt.status === 'cancelled') && LATE_SUCCESS_REASONS.includes(attempt.failureReason ?? '');
  }

  /**
   * Succès tardif : le fournisseur confirme un encaissement sur une tentative déjà expirée ou abandonnée.
   * La tentative repasse à `succeeded` et `payment.succeeded` est publié ; l'abonné enregistre le paiement.
   */
  private async recheckLate(attempt: PaymentAttemptRow): Promise<SettlementOutcome> {
    const provider = this.providers.get(attempt.provider);
    if (!provider || !attempt.providerReference) {
      await this.ensureNotified(attempt);
      return attempt.status as SettlementOutcome;
    }
    const remote = await provider.getTransactionStatus(attempt.providerReference);
    if (remote.status !== 'succeeded') {
      await this.ensureNotified(attempt);
      return attempt.status as SettlementOutcome;
    }
    if (!this.matchesAttempt(attempt, remote)) {
      await this.alertMismatch(attempt, remote);
      return attempt.status as SettlementOutcome;
    }
    const now = this.clock.now();
    const won = await this.db.run((tx) => this.repo.settleLate(tx, attempt.id, now));
    const current = await this.db.run((tx) => this.repo.findById(tx, attempt.id));
    if (!current) return 'succeeded';
    if (won) await this.publish(current);
    return current.status as SettlementOutcome;
  }

  /** Succès annoncé pour un autre montant ou une autre devise : rien n'est crédité, une alerte de rapprochement est tracée. */
  private async alertMismatch(attempt: PaymentAttemptRow, remote: ProviderTransaction): Promise<void> {
    this.logger.error({ attemptId: attempt.id, provider: attempt.provider }, 'Rapprochement requis : paiement réussi mais montant ou devise différents de la tentative');
    await this.db.run((tx) =>
      this.audit.record(tx, {
        action: 'payment.amount_mismatch',
        actor: { type: 'system' },
        resourceType: 'payment_attempt',
        resourceId: attempt.id,
        tenantId: attempt.tenantId,
        outcome: 'failure',
        changes: {
          purpose: attempt.purpose,
          provider: attempt.provider,
          expected: formatMoney(attempt.amount),
          expectedCurrency: attempt.currency,
          reportedAmount: remote.amount,
          reportedCurrency: remote.currency,
        },
      }),
    );
  }

  /** Règle une tentative sans interroger le fournisseur (expiration). */
  async expire(attempt: PaymentAttemptRow): Promise<SettlementOutcome> {
    return this.settle(attempt, 'failed', FAILURE_REASONS.expired);
  }

  /** Marque la tentative comme échouée sans publication (refus explicite de tous les fournisseurs : l'appelant reçoit l'erreur). */
  async failSilently(attempt: PaymentAttemptRow, reason: string): Promise<void> {
    const now = this.clock.now();
    await this.db.run(async (tx) => {
      const won = await this.repo.settle(tx, attempt.id, { status: 'failed', failureReason: reason, at: now });
      await this.repo.markNotified(tx, attempt.id, now);
      if (won) await this.auditFailure(tx, attempt, reason);
    });
  }

  /** Abandon par l'encaisseur : `pending → cancelled` sans événement (le tenant a déjà libéré son paiement). */
  async cancel(attempt: PaymentAttemptRow): Promise<SettlementOutcome> {
    const now = this.clock.now();
    await this.db.run(async (tx) => {
      const won = await this.repo.settle(tx, attempt.id, { status: 'cancelled', failureReason: FAILURE_REASONS.abandoned, at: now });
      if (won) await this.repo.markNotified(tx, attempt.id, now);
    });
    const current = await this.db.run((tx) => this.repo.findById(tx, attempt.id));
    return (current?.status ?? 'cancelled') as SettlementOutcome;
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
    if (won) {
      if (status === 'failed') await this.db.run((tx) => this.auditFailure(tx, current, reason ?? 'unknown'));
      await this.publish(current);
    }
    return current.status as SettlementOutcome;
  }

  private auditFailure(tx: PlatformTx, attempt: PaymentAttemptRow, reason: string): Promise<void> {
    return this.audit.record(tx, {
      action: 'payment.attempt_failed',
      actor: { type: 'system' },
      resourceType: 'payment_attempt',
      resourceId: attempt.id,
      tenantId: attempt.tenantId,
      outcome: 'failure',
      changes: { purpose: attempt.purpose, provider: attempt.provider, reason },
    });
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
