import { Injectable } from '@nestjs/common';
import type { PaymentAttempt, PaymentEvent, Prisma } from '../../../generated/prisma/client';
import type { PlatformTx } from '../../../infrastructure/prisma/platform-db.service';

/** Motifs d'échec d'une tentative qui laissent la porte ouverte à un succès confirmé plus tard par l'agrégateur. */
export const LATE_SUCCESS_REASONS: readonly string[] = ['expired', 'provider_unavailable', 'abandoned'];

export type PaymentAttemptRow = PaymentAttempt;
export type PaymentEventRow = PaymentEvent;

export interface NewAttempt {
  readonly purpose: string;
  readonly tenantId: string;
  readonly referenceId: string;
  readonly amount: Prisma.Decimal;
  readonly currency: string;
  readonly channel: string;
  readonly provider: string;
  readonly providerReference: string;
  readonly idempotencyKey: string;
  readonly payerPhoneHash: string | null;
  readonly description: string;
}

export interface Settlement {
  readonly status: 'succeeded' | 'failed' | 'cancelled';
  readonly failureReason: string | null;
  readonly at: Date;
}

/** Accès Prisma aux tables `platform.payment_*` (transaction fournie par PlatformDb). */
@Injectable()
export class PaymentsRepository {
  findById(tx: PlatformTx, id: string): Promise<PaymentAttemptRow | null> {
    return tx.paymentAttempt.findUnique({ where: { id } });
  }

  findByIdempotencyKey(tx: PlatformTx, key: string): Promise<PaymentAttemptRow | null> {
    return tx.paymentAttempt.findUnique({ where: { idempotencyKey: key } });
  }

  findByProviderReference(tx: PlatformTx, provider: string, providerReference: string): Promise<PaymentAttemptRow | null> {
    return tx.paymentAttempt.findUnique({ where: { provider_providerReference: { provider, providerReference } } });
  }

  /** Tentatives encore en attente pour une référence (facture) donnée. */
  listPendingFor(tx: PlatformTx, tenantId: string, purpose: string, referenceId: string): Promise<PaymentAttemptRow[]> {
    return tx.paymentAttempt.findMany({ where: { tenantId, purpose, referenceId, status: 'pending' } });
  }

  create(tx: PlatformTx, data: NewAttempt): Promise<PaymentAttemptRow> {
    return tx.paymentAttempt.create({ data });
  }

  /** Enregistre le résultat de la création du paiement chez le fournisseur retenu. */
  attachCheckout(tx: PlatformTx, id: string, data: { provider: string; checkoutUrl: string | null; instructions: string | null }): Promise<PaymentAttemptRow> {
    return tx.paymentAttempt.update({ where: { id }, data });
  }

  /** Transition unique `pending → statut final` ; renvoie vrai pour le seul appelant qui a effectivement réglé la tentative. */
  async settle(tx: PlatformTx, id: string, settlement: Settlement): Promise<boolean> {
    const result = await tx.paymentAttempt.updateMany({
      where: { id, status: 'pending' },
      data: { status: settlement.status, failureReason: settlement.failureReason, settledAt: settlement.at },
    });
    return result.count === 1;
  }

  /**
   * Succès tardif : une tentative expirée, abandonnée ou sans réponse technique devient `succeeded` quand l'agrégateur
   * confirme l'encaissement. Jamais après un refus pour montant différent (le trigger SQL le garantit aussi).
   */
  async settleLate(tx: PlatformTx, id: string, at: Date): Promise<boolean> {
    const result = await tx.paymentAttempt.updateMany({
      where: { id, status: { in: ['failed', 'cancelled'] }, failureReason: { in: [...LATE_SUCCESS_REASONS] } },
      data: { status: 'succeeded', failureReason: null, settledAt: at, notifiedAt: null },
    });
    return result.count === 1;
  }

  async markChecked(tx: PlatformTx, id: string, at: Date): Promise<void> {
    await tx.paymentAttempt.update({ where: { id }, data: { lastCheckedAt: at, checkCount: { increment: 1 } } });
  }

  async markNotified(tx: PlatformTx, id: string, at: Date): Promise<void> {
    await tx.paymentAttempt.updateMany({ where: { id, notifiedAt: null }, data: { notifiedAt: at } });
  }

  /** Tentatives en attente à relancer : âgées de plus de `olderThan`, non vérifiées depuis `notCheckedSince`. */
  listPendingDue(tx: PlatformTx, olderThan: Date, notCheckedSince: Date, take: number, tenantIds?: readonly string[]): Promise<PaymentAttemptRow[]> {
    return tx.paymentAttempt.findMany({
      where: {
        status: 'pending',
        createdAt: { lte: olderThan },
        OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lte: notCheckedSince } }],
        ...(tenantIds ? { tenantId: { in: [...tenantIds] } } : {}),
      },
      orderBy: { createdAt: 'asc' },
      take,
    });
  }

  /** Règlements dont les abonnés n'ont pas (encore) confirmé la prise en compte. */
  listUnnotified(tx: PlatformTx, settledBefore: Date, take: number, tenantIds?: readonly string[]): Promise<PaymentAttemptRow[]> {
    return tx.paymentAttempt.findMany({
      where: {
        status: { in: ['succeeded', 'failed'] },
        notifiedAt: null,
        settledAt: { lte: settledBefore },
        ...(tenantIds ? { tenantId: { in: [...tenantIds] } } : {}),
      },
      orderBy: { settledAt: 'asc' },
      take,
    });
  }

  /** Insère l'événement brut ; renvoie null si `(provider, provider_event_id)` existe déjà. */
  async insertEvent(
    tx: PlatformTx,
    data: { provider: string; providerEventId: string; providerReference: string; rawBody: string; bodySha256: string },
  ): Promise<PaymentEventRow | null> {
    const rows = await tx.paymentEvent.createManyAndReturn({ data: [data], skipDuplicates: true });
    return rows[0] ?? null;
  }

  /** Rejeu strict d'un corps déjà reçu (même empreinte SHA-256), quel que soit l'identifiant d'événement annoncé. */
  findEventByBodyHash(tx: PlatformTx, provider: string, bodySha256: string): Promise<PaymentEventRow | null> {
    return tx.paymentEvent.findFirst({ where: { provider, bodySha256 } });
  }

  findEvent(tx: PlatformTx, provider: string, providerEventId: string): Promise<PaymentEventRow | null> {
    return tx.paymentEvent.findUnique({ where: { provider_providerEventId: { provider, providerEventId } } });
  }

  async completeEvent(tx: PlatformTx, id: string, data: { attemptId: string | null; outcome: string; at: Date }): Promise<void> {
    await tx.paymentEvent.update({ where: { id }, data: { attemptId: data.attemptId, outcome: data.outcome, processedAt: data.at } });
  }

  async tenantCountry(tx: PlatformTx, tenantId: string): Promise<string | null> {
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { countryCode: true } });
    return tenant?.countryCode ?? null;
  }
}
