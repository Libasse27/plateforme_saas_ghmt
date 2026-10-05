import { Injectable } from '@nestjs/common';
import { DomainError } from '../../../common/errors/domain-error';
import { Clock } from '../../../common/time/clock';

/** Intervalle minimal entre deux reprises manuelles d'un même paiement (évite de marteler l'agrégateur). */
export const REFRESH_MIN_INTERVAL_MS = 10_000;
const MAX_TRACKED_PAYMENTS = 5_000;

/**
 * Limite par paiement des reprises manuelles (`POST /billing/payments/:id/refresh`). Mémoire du processus : un déploiement
 * multi-instances admet au pire une reprise par instance, sans conséquence (la vérification chez l'agrégateur est idempotente).
 */
@Injectable()
export class RefreshThrottle {
  private readonly lastByPayment = new Map<string, number>();

  constructor(private readonly clock: Clock) {}

  /** Lève 429 si le paiement a été repris trop récemment ; sinon enregistre cette reprise. */
  assertAllowed(paymentId: string): void {
    const now = this.clock.now().getTime();
    const last = this.lastByPayment.get(paymentId);
    if (last !== undefined && now - last < REFRESH_MIN_INTERVAL_MS) {
      throw DomainError.tooManyRequests(Math.ceil((REFRESH_MIN_INTERVAL_MS - (now - last)) / 1000));
    }
    if (this.lastByPayment.size >= MAX_TRACKED_PAYMENTS) this.prune(now);
    this.lastByPayment.set(paymentId, now);
  }

  private prune(now: number): void {
    for (const [id, at] of this.lastByPayment) {
      if (now - at >= REFRESH_MIN_INTERVAL_MS) this.lastByPayment.delete(id);
    }
  }
}
