import { Injectable } from '@nestjs/common';
import { entitlementsSchema, type BillingPeriod, type DowngradeViolation, type EntitlementOverrides } from '@ghmt/shared';
import { PlatformAuditService, type PlatformActor } from '../../../common/audit/platform-audit.service';
import { DomainError } from '../../../common/errors/domain-error';
import { Prisma, type Plan, type SaasInvoice, type Subscription } from '../../../generated/prisma/client';
import { PlatformDb, type PlatformTx } from '../../../infrastructure/prisma/platform-db.service';
import { toMinor } from '../domain/money';
import { addDays } from '../domain/period';
import { invoiceDueKind } from '../domain/pricing';
import { SubscriptionsRepository } from '../repositories/subscriptions.repository';
import { InvoiceIssuerService } from './invoice-issuer.service';
import { toSnapshot } from './subscription-lifecycle.service';
import { SubscriptionStateService, type StatusChange } from './subscription-state.service';
import { TenantModulesSync } from './tenant-modules-sync';

export const TRIAL_EXTENSION_DAYS = 15;

export type PlanChangeEffect = 'immediate' | 'scheduled' | 'pending_payment';

export interface PlanChangeRequest {
  readonly tenantId: string;
  readonly planCode: string;
  readonly billingPeriod: BillingPeriod;
  readonly actor: PlatformActor;
  readonly now: Date;
  /** Console plateforme : autorise un plan non public et fixe des dérogations. */
  readonly platform?: { readonly overrides?: EntitlementOverrides | null };
}

export interface PlanChangeOutcome {
  readonly effect: PlanChangeEffect;
  readonly invoice: SaasInvoice | null;
}

const REACTIVATION_STATUSES = new Set(['expired', 'suspended', 'cancelled']);

function monthlyMinor(plan: Plan): bigint {
  return toMinor(plan.priceMonthly.toFixed(2));
}

/**
 * Changement de plan (docs/09 §A3, docs/05 A8) :
 * - essai : le plan change immédiatement et la facture de conversion est émise ;
 * - upgrade (actif, impayé, grâce) : immédiat, facture de prorata, droits et modules relevés ;
 * - downgrade ou changement de périodicité : planifié en fin de période après contrôle de compatibilité (409 sinon) ;
 * - réactivation (expiré, suspendu, résilié) : facture de conversion, plan appliqué au paiement.
 */
@Injectable()
export class PlanChangeService {
  constructor(
    private readonly platformDb: PlatformDb,
    private readonly repository: SubscriptionsRepository,
    private readonly state: SubscriptionStateService,
    private readonly issuer: InvoiceIssuerService,
    private readonly modules: TenantModulesSync,
    private readonly audit: PlatformAuditService,
  ) {}

  async change(request: PlanChangeRequest): Promise<PlanChangeOutcome> {
    const { outcome, changes } = await this.platformDb.run(async (tx) => {
      const subscription = await this.repository.lockByTenant(tx, request.tenantId);
      if (!subscription) throw DomainError.notFound('Abonnement');
      const target = await this.repository.latestPlanByCode(tx, request.planCode);
      if (!target || (!request.platform && !target.isPublic)) throw DomainError.notFound('Offre');
      const current = await this.requirePlan(tx, subscription.planId);

      const result = await this.apply(tx, { request, subscription, current, target });
      if (request.platform?.overrides !== undefined) {
        const overrides = request.platform.overrides;
        await tx.subscription.update({ where: { id: subscription.id }, data: { overrides: overrides === null ? Prisma.JsonNull : overrides } });
      }
      const refreshed = await tx.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
      const refreshedPlan = await this.requirePlan(tx, refreshed.planId);
      await this.modules.sync(tx, request.tenantId, refreshedPlan, refreshed, request.now);
      await this.audit.record(tx, {
        action: 'subscription.plan_change',
        actor: request.actor,
        resourceType: 'subscription',
        resourceId: subscription.id,
        tenantId: request.tenantId,
        changes: { from: current.code, to: target.code, billingPeriod: request.billingPeriod, effect: result.effect, invoice: result.invoice?.number ?? null },
      });
      return { outcome: { effect: result.effect, invoice: result.invoice }, changes: result.changes };
    });
    await this.state.publish(changes);
    return outcome;
  }

  /** Programme la résiliation à la fin de la période payée (pas de remboursement, docs/05 A8). */
  async cancelAtPeriodEnd(tenantId: string, actor: PlatformActor, now: Date): Promise<void> {
    await this.platformDb.run(async (tx) => {
      const subscription = await this.requireLocked(tx, tenantId);
      if (subscription.status !== 'active') throw DomainError.conflict('invalid_state', 'Seul un abonnement actif peut être résilié.');
      if (subscription.cancelAtPeriodEnd) return;
      await tx.subscription.update({ where: { id: subscription.id }, data: { cancelAtPeriodEnd: true } });
      await this.issuer.voidOpenRecurring(tx, subscription, now, actor, 'cancel_at_period_end');
      await this.audit.record(tx, { action: 'subscription.cancel_scheduled', actor, resourceType: 'subscription', resourceId: subscription.id, tenantId });
    });
  }

  async resume(tenantId: string, actor: PlatformActor): Promise<void> {
    await this.platformDb.run(async (tx) => {
      const subscription = await this.requireLocked(tx, tenantId);
      if (subscription.status !== 'active') throw DomainError.conflict('invalid_state', 'Seul un abonnement actif peut être repris.');
      if (!subscription.cancelAtPeriodEnd) return;
      await tx.subscription.update({ where: { id: subscription.id }, data: { cancelAtPeriodEnd: false } });
      await this.audit.record(tx, { action: 'subscription.cancel_withdrawn', actor, resourceType: 'subscription', resourceId: subscription.id, tenantId });
    });
  }

  /** Prolonge l'essai une seule fois de 15 jours (docs/05 A5). Les factures de conversion ouvertes sont annulées puis réémises. */
  async extendTrial(tenantId: string, actor: PlatformActor, now: Date): Promise<Subscription> {
    return this.platformDb.run(async (tx) => {
      const subscription = await this.requireLocked(tx, tenantId);
      if (subscription.status !== 'trial' || !subscription.trialEndsAt) throw DomainError.conflict('not_in_trial', 'L’établissement n’est pas en période d’essai.');
      if (subscription.trialExtended) throw DomainError.conflict('trial_already_extended', 'L’essai a déjà été prolongé une fois.');
      const trialEndsAt = addDays(subscription.trialEndsAt, TRIAL_EXTENSION_DAYS);
      await this.issuer.voidOpenRecurring(tx, subscription, now, actor, 'trial_extended');
      const updated = await tx.subscription.update({
        where: { id: subscription.id },
        data: { trialEndsAt, currentPeriodEnd: trialEndsAt, trialExtended: true },
      });
      await this.audit.record(tx, {
        action: 'subscription.trial_extended',
        actor,
        resourceType: 'subscription',
        resourceId: subscription.id,
        tenantId,
        changes: { days: TRIAL_EXTENSION_DAYS, trialEndsAt: trialEndsAt.toISOString() },
      });
      return updated;
    });
  }

  private async apply(
    tx: PlatformTx,
    ctx: { request: PlanChangeRequest; subscription: Subscription; current: Plan; target: Plan },
  ): Promise<{ effect: PlanChangeEffect; invoice: SaasInvoice | null; changes: StatusChange[] }> {
    const { request, subscription, current, target } = ctx;
    const samePlan = target.id === current.id;
    const samePeriod = request.billingPeriod === subscription.billingPeriod;

    if (subscription.status === 'trial') return this.changeDuringTrial(tx, ctx);
    if (REACTIVATION_STATUSES.has(subscription.status)) return this.requestReactivation(tx, ctx);

    if (samePlan && samePeriod && request.platform?.overrides === undefined) {
      throw DomainError.conflict('no_change', 'Cette offre et cette périodicité sont déjà celles de votre abonnement.');
    }
    const isUpgrade = !samePlan && monthlyMinor(target) > monthlyMinor(current);
    if (isUpgrade) return this.upgrade(tx, ctx);
    if (!samePlan || !samePeriod) return this.scheduleChange(tx, ctx);
    return { effect: 'immediate', invoice: null, changes: [] };
  }

  private async changeDuringTrial(
    tx: PlatformTx,
    ctx: { request: PlanChangeRequest; subscription: Subscription; target: Plan },
  ) {
    const { request, subscription, target } = ctx;
    await this.issuer.voidOpenRecurring(tx, subscription, request.now, request.actor, 'plan_change');
    const updated = await tx.subscription.update({
      where: { id: subscription.id },
      data: { planId: target.id, billingPeriod: request.billingPeriod },
    });
    const invoice = await this.issuer.issueRecurring(tx, {
      subscription: updated,
      plan: target,
      billingPeriod: request.billingPeriod,
      kind: 'conversion',
      periodStart: subscription.trialEndsAt ?? subscription.currentPeriodEnd,
      now: request.now,
      actor: request.actor,
    });
    return { effect: 'immediate' as const, invoice, changes: [] as StatusChange[] };
  }

  private async requestReactivation(
    tx: PlatformTx,
    ctx: { request: PlanChangeRequest; subscription: Subscription; current: Plan; target: Plan },
  ) {
    const { request, subscription, current, target } = ctx;
    await this.issuer.voidOpenRecurring(tx, subscription, request.now, request.actor, 'reactivation_request');
    const differs = target.id !== current.id || request.billingPeriod !== subscription.billingPeriod;
    const updated = await tx.subscription.update({
      where: { id: subscription.id },
      data: { pendingPlanId: differs ? target.id : null, pendingBillingPeriod: differs ? request.billingPeriod : null },
    });
    const invoice = await this.issuer.issueRecurring(tx, {
      subscription: updated,
      plan: target,
      billingPeriod: request.billingPeriod,
      kind: 'conversion',
      periodStart: request.now,
      now: request.now,
      actor: request.actor,
    });
    return { effect: 'pending_payment' as const, invoice, changes: [] as StatusChange[] };
  }

  private async upgrade(tx: PlatformTx, ctx: { request: PlanChangeRequest; subscription: Subscription; current: Plan; target: Plan }) {
    const { request, subscription, current, target } = ctx;
    const prorata = await this.issuer.issueProrata(tx, { subscription, from: current, to: target, now: request.now, actor: request.actor });
    await this.issuer.voidOpenRecurring(tx, subscription, request.now, request.actor, 'plan_change');
    const periodChanges = request.billingPeriod !== subscription.billingPeriod;
    const updated = await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        planId: target.id,
        pendingPlanId: null,
        // Une périodicité différente s'applique au prochain renouvellement (le prorata est calculé sur la période en cours).
        pendingBillingPeriod: periodChanges ? request.billingPeriod : null,
      },
    });
    await this.reissueIfDue(tx, updated, request);
    return { effect: 'immediate' as const, invoice: prorata, changes: [] as StatusChange[] };
  }

  private async scheduleChange(tx: PlatformTx, ctx: { request: PlanChangeRequest; subscription: Subscription; current: Plan; target: Plan }) {
    const { request, subscription, current, target } = ctx;
    if (target.id !== current.id) await this.assertDowngradeCompatible(tx, subscription.tenantId, target, request.now);
    await this.issuer.voidOpenRecurring(tx, subscription, request.now, request.actor, 'plan_change');
    const updated = await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        pendingPlanId: target.id !== current.id ? target.id : null,
        pendingBillingPeriod: request.billingPeriod !== subscription.billingPeriod ? request.billingPeriod : null,
      },
    });
    await this.reissueIfDue(tx, updated, request);
    return { effect: 'scheduled' as const, invoice: null, changes: [] as StatusChange[] };
  }

  /** Réémet immédiatement la facture de renouvellement (nouveau tarif) si elle est déjà due, sans attendre le job horaire. */
  private async reissueIfDue(tx: PlatformTx, subscription: Subscription, request: PlanChangeRequest): Promise<void> {
    const kind = invoiceDueKind(toSnapshot(subscription), request.now);
    if (kind !== 'renewal') return;
    const plan = await this.requirePlan(tx, subscription.pendingPlanId ?? subscription.planId);
    await this.issuer.issueRecurring(tx, {
      subscription,
      plan,
      billingPeriod: subscription.pendingBillingPeriod ?? subscription.billingPeriod,
      kind,
      periodStart: subscription.currentPeriodEnd,
      now: request.now,
      actor: request.actor,
    });
  }

  /** Utilisateurs et sites actuels doivent tenir dans le plan cible, sinon 409 avec la liste des dépassements. */
  private async assertDowngradeCompatible(tx: PlatformTx, tenantId: string, target: Plan, now: Date): Promise<void> {
    const limits = entitlementsSchema.parse(target.entitlements).limits;
    const [usage] = await this.repository.usageOf(tx, [tenantId], now);
    const violations: DowngradeViolation[] = [];
    if (usage && limits.users !== null && usage.users > limits.users) violations.push({ metric: 'users', limit: limits.users, current: usage.users });
    if (usage && limits.sites !== null && usage.sites > limits.sites) violations.push({ metric: 'sites', limit: limits.sites, current: usage.sites });
    if (violations.length > 0) {
      throw DomainError.conflict('downgrade_incompatible', 'L’usage actuel dépasse les limites de l’offre demandée.', { details: { violations } });
    }
  }

  private async requirePlan(tx: PlatformTx, id: string): Promise<Plan> {
    const plan = await this.repository.findPlan(tx, id);
    if (!plan) throw DomainError.notFound('Offre');
    return plan;
  }

  private async requireLocked(tx: PlatformTx, tenantId: string): Promise<Subscription> {
    const subscription = await this.repository.lockByTenant(tx, tenantId);
    if (!subscription) throw DomainError.notFound('Abonnement');
    return subscription;
  }
}
