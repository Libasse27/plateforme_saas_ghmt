import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Clock } from '../../../common/time/clock';
import type { Subscription } from '../../../generated/prisma/client';
import { PlatformDb } from '../../../infrastructure/prisma/platform-db.service';
import { addDays } from '../domain/period';
import { INVOICE_LEAD_DAYS, invoiceDueKind } from '../domain/pricing';
import { nextLifecycleStatus, type LifecycleSnapshot } from '../domain/subscription-state-machine';
import { SubscriptionsRepository } from '../repositories/subscriptions.repository';
import { InvoiceIssuerService } from './invoice-issuer.service';
import { SubscriptionStateService, type StatusChange } from './subscription-state.service';

const BATCH_SIZE = 200;
/** Garde-fou : un abonnement très en retard franchit plusieurs états en une exécution (jamais une boucle infinie). */
const MAX_STEPS_PER_RUN = 8;
const SYSTEM_ACTOR = { type: 'system' } as const;

export interface LifecycleReport {
  readonly examined: number;
  readonly transitions: readonly StatusChange[];
  readonly invoicesIssued: number;
  readonly errors: number;
}

export function toSnapshot(subscription: Subscription): LifecycleSnapshot {
  return {
    status: subscription.status,
    currentPeriodEnd: subscription.currentPeriodEnd,
    trialEndsAt: subscription.trialEndsAt,
    statusChangedAt: subscription.statusChangedAt,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
  };
}

/**
 * Cycle de vie des abonnements (docs/05 A6, docs/09 §A3) : transitions automatiques et émission des factures à J-7.
 * `runLifecycle(now)` est déterministe (l'horloge est un paramètre) ; la tâche planifiée horaire l'appelle avec `Clock`.
 * Chaque abonnement est traité dans sa propre transaction : l'échec de l'un n'interrompt pas les autres.
 */
@Injectable()
export class SubscriptionLifecycleService {
  private readonly logger = new Logger(SubscriptionLifecycleService.name);

  constructor(
    private readonly platformDb: PlatformDb,
    private readonly repository: SubscriptionsRepository,
    private readonly state: SubscriptionStateService,
    private readonly issuer: InvoiceIssuerService,
    private readonly clock: Clock,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async scheduledRun(): Promise<void> {
    try {
      const report = await this.runLifecycle(this.clock.now());
      this.logger.log({ examined: report.examined, transitions: report.transitions.length, invoices: report.invoicesIssued, errors: report.errors }, 'Cycle de vie des abonnements');
    } catch (error: unknown) {
      this.logger.error({ error: error instanceof Error ? error.name : 'unknown' }, 'Échec du cycle de vie des abonnements');
    }
  }

  /** `options.tenantIds` restreint l'exécution à certains établissements (tests, rattrapage ciblé) ; absent = tous. */
  async runLifecycle(now: Date, options: { readonly tenantIds?: readonly string[] } = {}): Promise<LifecycleReport> {
    const transitions: StatusChange[] = [];
    let examined = 0;
    let invoicesIssued = 0;
    let errors = 0;

    let cursor: string | undefined;
    for (;;) {
      const ids = await this.candidateIds(now, cursor, options.tenantIds);
      if (ids.length === 0) break;
      for (const id of ids) {
        examined += 1;
        try {
          const outcome = await this.processOne(id, now);
          transitions.push(...outcome.changes);
          invoicesIssued += outcome.invoices;
          await this.state.publish(outcome.changes);
        } catch (error: unknown) {
          errors += 1;
          this.logger.error({ subscriptionId: id, error: error instanceof Error ? error.name : 'unknown' }, 'Échec du traitement d’un abonnement');
        }
      }
      cursor = ids[ids.length - 1];
      if (ids.length < BATCH_SIZE) break;
    }
    return { examined, transitions, invoicesIssued, errors };
  }

  /** Abonnements pour lesquels une transition ou une facture peut être due à `now`. */
  private candidateIds(now: Date, after: string | undefined, tenantIds: readonly string[] | undefined): Promise<string[]> {
    const horizon = addDays(now, INVOICE_LEAD_DAYS);
    return this.platformDb.run(async (tx) => {
      const rows = await tx.subscription.findMany({
        where: {
          status: { not: 'expired' },
          ...(after ? { id: { gt: after } } : {}),
          ...(tenantIds ? { tenantId: { in: [...tenantIds] } } : {}),
          OR: [{ currentPeriodEnd: { lte: horizon } }, { trialEndsAt: { lte: horizon } }, { status: 'cancelled' }],
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
      });
      return rows.map((r) => r.id);
    });
  }

  private processOne(id: string, now: Date): Promise<{ changes: StatusChange[]; invoices: number }> {
    return this.platformDb.run(async (tx) => {
      let subscription = await this.repository.lockById(tx, id);
      if (!subscription) return { changes: [], invoices: 0 };

      const changes: StatusChange[] = [];
      for (let step = 0; step < MAX_STEPS_PER_RUN; step += 1) {
        const next = nextLifecycleStatus(toSnapshot(subscription), now);
        if (!next) break;
        const change = await this.state.transition(tx, subscription, next, { actor: SYSTEM_ACTOR, reason: 'lifecycle', now });
        if (change) changes.push(change);
        subscription = await tx.subscription.findUniqueOrThrow({ where: { id } });
      }

      const kind = invoiceDueKind(toSnapshot(subscription), now);
      if (!kind) return { changes, invoices: 0 };
      const planId = subscription.pendingPlanId ?? subscription.planId;
      const plan = await this.repository.findPlan(tx, planId);
      if (!plan) return { changes, invoices: 0 };
      const periodStart = kind === 'conversion' ? subscription.trialEndsAt! : subscription.currentPeriodEnd;
      const invoice = await this.issuer.issueRecurring(tx, {
        subscription,
        plan,
        billingPeriod: subscription.pendingBillingPeriod ?? subscription.billingPeriod,
        kind,
        periodStart,
        now,
        actor: SYSTEM_ACTOR,
      });
      return { changes, invoices: invoice ? 1 : 0 };
    });
  }
}
