import { Injectable } from '@nestjs/common';
import { DomainError } from '../../../common/errors/domain-error';

const WINDOW_MS = 60_000;
const MAX_PER_USER = 3;

/**
 * Garde de la vérification d'intégrité (coûteuse, jusqu'à 50 000 maillons) : 3 par minute et PAR UTILISATEUR (le limiteur par IP,
 * lui, se contourne en changeant d'adresse) et une seule exécution à la fois par établissement. État en mémoire du processus.
 */
@Injectable()
export class AuditVerifyLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly running = new Set<string>();

  async run<T>(principal: { userId: string; tenantId: string }, task: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const recent = (this.hits.get(principal.userId) ?? []).filter((at) => now - at < WINDOW_MS);
    if (recent.length >= MAX_PER_USER) throw DomainError.tooManyRequests(Math.ceil(WINDOW_MS / 1_000));
    if (this.running.has(principal.tenantId)) {
      throw new DomainError('verification_in_progress', 429, 'Too Many Requests', 'Une vérification est déjà en cours pour cet établissement.', { retryAfterSeconds: 5 });
    }
    this.hits.set(principal.userId, [...recent, now]);
    this.running.add(principal.tenantId);
    try {
      return await task();
    } finally {
      this.running.delete(principal.tenantId);
    }
  }
}
