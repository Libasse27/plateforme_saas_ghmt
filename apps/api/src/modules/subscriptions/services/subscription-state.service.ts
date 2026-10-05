import { Injectable } from '@nestjs/common';
import type { SubscriptionStatus } from '@ghmt/shared';
import { PlatformAuditService, type PlatformActor } from '../../../common/audit/platform-audit.service';
import { DomainError } from '../../../common/errors/domain-error';
import { DomainEventBus } from '../../../common/events/domain-event-bus';
import type { Subscription } from '../../../generated/prisma/client';
import type { PlatformTx } from '../../../infrastructure/prisma/platform-db.service';
import { canTransition } from '../domain/subscription-state-machine';

/** Changement de statut effectif, à publier APRÈS validation de la transaction. */
export interface StatusChange {
  readonly tenantId: string;
  readonly subscriptionId: string;
  readonly from: SubscriptionStatus;
  readonly to: SubscriptionStatus;
  readonly at: string;
}

export interface TransitionRequest {
  readonly actor: PlatformActor;
  readonly reason: string;
  readonly now: Date;
  /** Champs d'abonnement mis à jour atomiquement avec le statut (période, plan…). */
  readonly patch?: Partial<Pick<Subscription, 'currentPeriodStart' | 'currentPeriodEnd' | 'planId' | 'billingPeriod' | 'cancelAtPeriodEnd' | 'pendingPlanId' | 'pendingBillingPeriod'>>;
}

/** Statuts pour lesquels le tenant passe en lecture seule (continuité des soins uniquement ; docs/09 §R) (`platform.tenants.status = 'suspended'`). */
const READ_ONLY_STATUSES: ReadonlySet<SubscriptionStatus> = new Set(['suspended', 'cancelled', 'expired']);

/**
 * Unique point de modification de `subscriptions.status` (docs/05 A6) : valide la transition, l'applique de façon
 * atomique (la ligne doit être verrouillée par l'appelant), répercute l'effet sur le statut du tenant, audite.
 * La publication de `subscription.status_changed` se fait après commit via `publish`.
 */
@Injectable()
export class SubscriptionStateService {
  constructor(
    private readonly audit: PlatformAuditService,
    private readonly events: DomainEventBus,
  ) {}

  async transition(tx: PlatformTx, subscription: Subscription, to: SubscriptionStatus, request: TransitionRequest): Promise<StatusChange | null> {
    const from = subscription.status;
    if (!canTransition(from, to)) {
      throw DomainError.conflict('invalid_transition', `Transition d’abonnement impossible : ${from} → ${to}.`);
    }
    const changed = from !== to;
    const updated = await tx.subscription.updateMany({
      where: { id: subscription.id, status: from },
      data: { status: to, ...(changed ? { statusChangedAt: request.now } : {}), ...request.patch },
    });
    if (updated.count !== 1) throw DomainError.conflict('concurrent_update', 'L’abonnement a été modifié entre-temps.');

    if (changed) await this.applyTenantEffect(tx, subscription, from, to);
    await this.audit.record(tx, {
      action: 'subscription.status_changed',
      actor: request.actor,
      resourceType: 'subscription',
      resourceId: subscription.id,
      tenantId: subscription.tenantId,
      changes: { from, to, reason: request.reason },
    });
    return changed ? { tenantId: subscription.tenantId, subscriptionId: subscription.id, from, to, at: request.now.toISOString() } : null;
  }

  /** Publie les événements après commit (jamais dans la transaction : les abonnés ouvrent leurs propres transactions). */
  async publish(changes: readonly (StatusChange | null)[]): Promise<void> {
    for (const change of changes) {
      if (change) await this.events.publish('subscription.status_changed', change);
    }
  }

  /**
   * Suspension/expiration ⇒ tenant en lecture seule (appliquée par PermissionGuard). Sortie de ces statuts ⇒ tenant réactivé,
   * sauf suspension décidée par la plateforme (motif manuel) qu'un paiement ne lève pas.
   */
  private async applyTenantEffect(tx: PlatformTx, subscription: Subscription, from: SubscriptionStatus, to: SubscriptionStatus): Promise<void> {
    const enteringReadOnly = READ_ONLY_STATUSES.has(to) && !READ_ONLY_STATUSES.has(from);
    const leavingReadOnly = READ_ONLY_STATUSES.has(from) && !READ_ONLY_STATUSES.has(to);
    if (enteringReadOnly) {
      await tx.tenant.updateMany({ where: { id: subscription.tenantId, status: 'active' }, data: { status: 'suspended' } });
    } else if (leavingReadOnly && subscription.manualSuspensionReason === null) {
      await tx.tenant.updateMany({ where: { id: subscription.tenantId, status: 'suspended' }, data: { status: 'active' } });
    }
  }
}
