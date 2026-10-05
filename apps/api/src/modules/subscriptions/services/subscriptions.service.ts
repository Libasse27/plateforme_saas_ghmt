import { Injectable } from '@nestjs/common';
import {
  TRIAL_SELECTABLE_PLAN_CODES,
  entitlementsSchema,
  type ChangePlanInput,
  type ChangePlanResult,
  type PublicPlanView,
  type SubscriptionStatusView,
  type SubscriptionView,
} from '@ghmt/shared';
import { AuditService } from '../../../common/audit/audit.service';
import { EntitlementService } from '../../../common/authz/entitlement.service';
import { RequestContext } from '../../../common/context/request-context';
import { DomainError } from '../../../common/errors/domain-error';
import { Clock } from '../../../common/time/clock';
import { TenantDb } from '../../../infrastructure/prisma/tenant-db.service';
import { toPlanSummary, toSaasInvoiceView, toSubscriptionView } from '../mappers/subscription.mapper';
import { accessModeOf, trialDaysLeft } from '../domain/access-mode';
import { PlanChangeService } from './plan-change.service';
import { PlatformDb } from '../../../infrastructure/prisma/platform-db.service';

/** Façade tenant de l'abonnement : consultation, changement de plan, résiliation programmée. */
@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly platformDb: PlatformDb,
    private readonly entitlements: EntitlementService,
    private readonly planChange: PlanChangeService,
    private readonly audit: AuditService,
    private readonly context: RequestContext,
    private readonly clock: Clock,
  ) {}

  /** Plan, statut, période, essai, droits et usage de l'établissement courant. */
  get(): Promise<SubscriptionView> {
    return this.tenantDb.run(async (tx) => {
      const current = await this.entitlements.getInTx(tx);
      if (!current) throw DomainError.notFound('Abonnement');
      return toSubscriptionView(current, await this.entitlements.usageInTx(tx, this.clock.now()));
    });
  }

  /** Statut et mode d'accès (R1) : lisible par tout utilisateur de l'établissement, sans aucune donnée financière. */
  status(): Promise<SubscriptionStatusView> {
    return this.tenantDb.run(async (tx) => {
      const current = await this.entitlements.getInTx(tx);
      if (!current) throw DomainError.notFound('Abonnement');
      const { status, trialEndsAt } = current.subscription;
      return {
        status,
        trialEndsAt: status === 'trial' ? (trialEndsAt?.toISOString() ?? null) : null,
        daysLeft: trialDaysLeft(status, trialEndsAt, this.clock.now()),
        mode: accessModeOf(status),
      };
    });
  }

  /** Offres publiques en vigueur (dernière version non archivée de chaque code), pour le changement de plan. */
  async listPlans(): Promise<PublicPlanView[]> {
    const inTrial = (await this.tenantDb.run((tx) => this.entitlements.getInTx(tx)))?.subscription.status === 'trial';
    const plans = await this.platformDb.run((tx) =>
      tx.plan.findMany({ where: { isPublic: true, archivedAt: null }, orderBy: [{ code: 'asc' }, { version: 'desc' }] }),
    );
    const latestByCode = new Map(plans.map((plan) => [plan.code, plan] as const).reverse());
    return [...latestByCode.values()]
      .sort((a, b) => Number(a.priceMonthly) - Number(b.priceMonthly))
      .map((plan) => ({
        ...toPlanSummary(plan),
        entitlements: entitlementsSchema.parse(plan.entitlements),
        // Pendant l'essai, seules les offres basic et standard peuvent être choisies.
        selectable: !inTrial || (TRIAL_SELECTABLE_PLAN_CODES as readonly string[]).includes(plan.tier),
      }));
  }

  async change(input: ChangePlanInput): Promise<ChangePlanResult> {
    const principal = this.context.requirePrincipal();
    const outcome = await this.planChange.change({
      tenantId: principal.tenantId,
      planCode: input.planCode,
      billingPeriod: input.billingPeriod,
      actor: { type: 'tenant_user', userId: principal.userId },
      now: this.clock.now(),
    });
    await this.tenantDb.run((tx) =>
      this.audit.record(tx, principal.tenantId, {
        action: 'subscription.plan_change_requested',
        resourceType: 'subscription',
        changes: { planCode: input.planCode, billingPeriod: input.billingPeriod, effect: outcome.effect },
      }),
    );
    const invoice = outcome.invoice
      ? await this.platformDb.run((tx) => tx.saasInvoice.findUniqueOrThrow({ where: { id: outcome.invoice!.id }, include: { lines: true } }))
      : null;
    return { effect: outcome.effect, subscription: await this.get(), invoice: invoice ? toSaasInvoiceView(invoice) : null };
  }

  async cancel(): Promise<SubscriptionView> {
    const principal = this.context.requirePrincipal();
    await this.planChange.cancelAtPeriodEnd(principal.tenantId, { type: 'tenant_user', userId: principal.userId }, this.clock.now());
    await this.auditAction('subscription.cancel_requested');
    return this.get();
  }

  async resume(): Promise<SubscriptionView> {
    const principal = this.context.requirePrincipal();
    await this.planChange.resume(principal.tenantId, { type: 'tenant_user', userId: principal.userId });
    await this.auditAction('subscription.cancel_withdrawn');
    return this.get();
  }

  private auditAction(action: string): Promise<void> {
    const principal = this.context.requirePrincipal();
    return this.tenantDb.run((tx) => this.audit.record(tx, principal.tenantId, { action, resourceType: 'subscription' }));
  }
}
