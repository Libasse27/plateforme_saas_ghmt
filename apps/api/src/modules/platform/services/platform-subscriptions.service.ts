import { Injectable } from '@nestjs/common';
import type { PlatformChangePlanInput, PlatformChangePlanResult, PlatformSubscriptionView } from '@ghmt/shared';
import { Clock } from '../../../common/time/clock';
import { DomainError } from '../../../common/errors/domain-error';
import { PlatformDb, type PlatformTx } from '../../../infrastructure/prisma/platform-db.service';
import { toPlanSummary, toSaasInvoiceView } from '../../subscriptions/mappers/subscription.mapper';
import { PlanChangeService } from '../../subscriptions/services/plan-change.service';
import { SubscriptionsRepository } from '../../subscriptions/repositories/subscriptions.repository';
import { effectiveEntitlements } from '../../subscriptions/services/tenant-modules-sync';
import type { PlatformPrincipal } from '../auth/platform-auth.guard';
import { actorOf } from './platform-actor';

/** Abonnements vus par la console (docs/09 §A5) : consultation, changement de plan, prolongation de l'essai. */
@Injectable()
export class PlatformSubscriptionsService {
  constructor(
    private readonly platformDb: PlatformDb,
    private readonly repository: SubscriptionsRepository,
    private readonly planChange: PlanChangeService,
    private readonly clock: Clock,
  ) {}

  get(tenantId: string): Promise<PlatformSubscriptionView> {
    return this.platformDb.run(async (tx) => {
      const view = await this.viewIn(tx, tenantId, this.clock.now());
      if (!view) throw DomainError.notFound('Abonnement');
      return view;
    });
  }

  async changePlan(tenantId: string, input: PlatformChangePlanInput, principal: PlatformPrincipal): Promise<PlatformChangePlanResult> {
    const now = this.clock.now();
    await this.assertMayChange(input, principal);
    const outcome = await this.planChange.change({
      tenantId,
      planCode: input.planCode,
      billingPeriod: input.billingPeriod,
      actor: actorOf(principal),
      now,
      platform: { overrides: input.overrides },
    });
    return this.platformDb.run(async (tx) => {
      const subscription = await this.requireView(tx, tenantId, now);
      const invoice = outcome.invoice ? await tx.saasInvoice.findUniqueOrThrow({ where: { id: outcome.invoice.id }, include: { lines: true } }) : null;
      return { effect: outcome.effect, subscription, invoice: invoice ? toSaasInvoiceView(invoice) : null };
    });
  }

  /** Dérogations de droits et plans non publics : décision commerciale réservée au Super Administrateur (revue sécurité M7). */
  private async assertMayChange(input: PlatformChangePlanInput, principal: PlatformPrincipal): Promise<void> {
    if (principal.role === 'super_admin') return;
    const target = await this.platformDb.run((tx) => this.repository.latestPlanByCode(tx, input.planCode));
    if (input.overrides !== undefined || (target && !target.isPublic)) {
      throw DomainError.forbidden('super_admin_required', 'Cette action est réservée au Super Administrateur.');
    }
  }

  async extendTrial(tenantId: string, principal: PlatformPrincipal): Promise<PlatformSubscriptionView> {
    const now = this.clock.now();
    await this.planChange.extendTrial(tenantId, actorOf(principal), now);
    return this.platformDb.run((tx) => this.requireView(tx, tenantId, now));
  }

  async requireView(tx: PlatformTx, tenantId: string, now: Date): Promise<PlatformSubscriptionView> {
    const view = await this.viewIn(tx, tenantId, now);
    if (!view) throw DomainError.notFound('Abonnement');
    return view;
  }

  /** Vue complète : plan, droits effectifs (plan ⊕ dérogations) et usage (comptes agrégés, aucune donnée patient). */
  async viewIn(tx: PlatformTx, tenantId: string, now: Date): Promise<PlatformSubscriptionView | null> {
    const subscription = await tx.subscription.findUnique({ where: { tenantId } });
    if (!subscription) return null;
    const plan = await this.repository.findPlan(tx, subscription.planId);
    if (!plan) return null;
    const pending = subscription.pendingPlanId ? await this.repository.findPlan(tx, subscription.pendingPlanId) : null;
    const [usage] = await this.repository.usageOf(tx, [tenantId]);
    return {
      id: subscription.id,
      tenantId,
      status: subscription.status,
      billingPeriod: subscription.billingPeriod,
      currentPeriodStart: subscription.currentPeriodStart.toISOString(),
      currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
      trialEndsAt: subscription.trialEndsAt?.toISOString() ?? null,
      trialExtended: subscription.trialExtended,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      suspensionReason: subscription.manualSuspensionReason,
      plan: toPlanSummary(plan),
      pendingChange:
        pending || subscription.pendingBillingPeriod
          ? {
              planCode: (pending ?? plan).code,
              billingPeriod: subscription.pendingBillingPeriod ?? subscription.billingPeriod,
              effectiveAt: subscription.currentPeriodEnd.toISOString(),
            }
          : null,
      entitlements: effectiveEntitlements(plan, subscription),
      usage: { users: usage?.users ?? 0, sites: usage?.sites ?? 0, appointmentsThisMonth: usage?.appointmentsMonth ?? 0 },
    };
  }
}
