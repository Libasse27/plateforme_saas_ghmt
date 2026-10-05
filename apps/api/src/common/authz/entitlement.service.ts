import { Injectable, Logger } from '@nestjs/common';
import {
  entitlementOverridesSchema,
  entitlementsSchema,
  mergeEntitlements,
  type BillingPeriod,
  type Entitlements,
  type PlanTier,
  type SubscriptionStatus,
  type SubscriptionUsage,
} from '@ghmt/shared';
import { Clock } from '../time/clock';
import { TenantDb, type TenantTx } from '../../infrastructure/prisma/tenant-db.service';
import { appointmentQuotaDecision, hardLimitViolation, planLimitReached, utcMonthBounds } from './entitlement-rules';

/** Utilisateurs comptés dans la limite du plan : actifs, invités et verrouillés (pas les désactivés). */
const COUNTED_USER_STATUSES = ['active', 'invited', 'locked'] as const;
const INACTIVE_APPOINTMENT_STATUSES = ['cancelled', 'no_show'] as const;

export interface TenantSubscriptionInfo {
  readonly id: string;
  readonly status: SubscriptionStatus;
  readonly billingPeriod: BillingPeriod;
  readonly currentPeriodStart: Date;
  readonly currentPeriodEnd: Date;
  readonly trialEndsAt: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly pendingPlanCode: string | null;
  readonly pendingBillingPeriod: BillingPeriod | null;
}

export interface TenantPlanInfo {
  readonly id: string;
  readonly code: string;
  readonly version: number;
  readonly name: string;
  readonly tier: PlanTier;
  readonly priceMonthly: string;
  readonly priceYearly: string;
  readonly currency: string;
}

export interface TenantEntitlements {
  readonly subscription: TenantSubscriptionInfo;
  readonly plan: TenantPlanInfo;
  /** Droits effectifs : plan ⊕ dérogations (overrides) de l'abonnement. */
  readonly entitlements: Entitlements;
}

interface SubscriptionRow {
  subscription_id: string;
  status: SubscriptionStatus;
  billing_period: BillingPeriod;
  current_period_start: Date;
  current_period_end: Date;
  trial_ends_at: Date | null;
  cancel_at_period_end: boolean;
  overrides: unknown;
  plan_id: string;
  plan_code: string;
  plan_version: number;
  plan_name: string;
  plan_tier: PlanTier;
  price_monthly: string;
  price_yearly: string;
  currency: string;
  entitlements: unknown;
  pending_plan_code: string | null;
  pending_billing_period: BillingPeriod | null;
}

/**
 * Point d'accès unique aux droits d'un tenant (docs/05 A7) : le code métier n'interroge JAMAIS directement le plan.
 * Lecture via la fonction SECURITY DEFINER `platform.current_tenant_subscription()` (tenant lu dans le contexte RLS) ;
 * un tenant historique sans abonnement n'est soumis à aucune limite (`null`).
 */
@Injectable()
export class EntitlementService {
  private readonly logger = new Logger(EntitlementService.name);

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly clock: Clock,
  ) {}

  /** Droits du tenant `tenantId` (résolu côté serveur : jamais fourni par le client). */
  get(tenantId: string): Promise<TenantEntitlements | null> {
    return this.tenantDb.runAs(tenantId, (tx) => this.getInTx(tx));
  }

  async getInTx(tx: TenantTx): Promise<TenantEntitlements | null> {
    const rows = await tx.$queryRaw<SubscriptionRow[]>`
      SELECT subscription_id::text, status, billing_period, current_period_start, current_period_end, trial_ends_at,
             cancel_at_period_end, overrides, plan_id::text, plan_code, plan_version, plan_name, plan_tier,
             price_monthly::text, price_yearly::text, currency::text, entitlements, pending_plan_code, pending_billing_period
      FROM platform.current_tenant_subscription()`;
    const row = rows[0];
    if (!row) return null;
    return {
      subscription: {
        id: row.subscription_id,
        status: row.status,
        billingPeriod: row.billing_period,
        currentPeriodStart: row.current_period_start,
        currentPeriodEnd: row.current_period_end,
        trialEndsAt: row.trial_ends_at,
        cancelAtPeriodEnd: row.cancel_at_period_end,
        pendingPlanCode: row.pending_plan_code,
        pendingBillingPeriod: row.pending_billing_period,
      },
      plan: {
        id: row.plan_id,
        code: row.plan_code,
        version: row.plan_version,
        name: row.plan_name,
        tier: row.plan_tier,
        priceMonthly: row.price_monthly,
        priceYearly: row.price_yearly,
        currency: row.currency.trim(),
      },
      entitlements: this.parseEntitlements(row),
    };
  }

  /** Usage courant du tenant (décomptes sous RLS, sans donnée patient). */
  async usageInTx(tx: TenantTx, now: Date = this.clock.now()): Promise<SubscriptionUsage> {
    const { start, end } = utcMonthBounds(now);
    const [users, sites, appointmentsThisMonth] = await Promise.all([
      this.countUsers(tx),
      this.countSites(tx),
      this.countAppointments(tx, start, end),
    ]);
    return { users, sites, appointmentsThisMonth };
  }

  /** Limite dure : création ou invitation d'un utilisateur (403 `plan_limit_reached`). Sérialise les ajouts concurrents. */
  async assertCanAddUser(tx: TenantTx): Promise<void> {
    await this.lock(tx, 'users');
    const current = await this.getInTx(tx);
    if (!current) return;
    const violation = hardLimitViolation(current.entitlements.limits.users, await this.countUsers(tx));
    if (violation) throw planLimitReached('users', violation);
  }

  async assertCanAddSite(tx: TenantTx): Promise<void> {
    await this.lock(tx, 'sites');
    const current = await this.getInTx(tx);
    if (!current) return;
    const violation = hardLimitViolation(current.entitlements.limits.sites, await this.countSites(tx));
    if (violation) throw planLimitReached('sites', violation);
  }

  /** Limite souple : au-delà de 120 % du quota mensuel, seules les sources en ligne sont refusées. */
  async assertAppointmentAllowed(tx: TenantTx, input: { source: string; startsAt: Date }): Promise<void> {
    const current = await this.getInTx(tx);
    if (!current) return;
    const limit = current.entitlements.limits.appointmentsMonthly;
    if (limit === null) return;
    const { start, end } = utcMonthBounds(input.startsAt);
    const count = await this.countAppointments(tx, start, end);
    if (appointmentQuotaDecision({ limit, current: count, source: input.source }) === 'refused') {
      throw planLimitReached('appointmentsMonthly', { limit, current: count });
    }
  }

  /** Verrou d'avis transactionnel par tenant et par métrique : deux créations simultanées ne dépassent pas la limite. */
  private async lock(tx: TenantTx, metric: string): Promise<void> {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended('plan-limit:' || ${metric} || ':' || current_setting('app.tenant_id', true), 0))`;
  }

  private countUsers(tx: TenantTx): Promise<number> {
    return tx.user.count({ where: { deletedAt: null, status: { in: [...COUNTED_USER_STATUSES] } } });
  }

  private countSites(tx: TenantTx): Promise<number> {
    return tx.site.count({ where: { deletedAt: null } });
  }

  private countAppointments(tx: TenantTx, start: Date, end: Date): Promise<number> {
    return tx.appointment.count({
      where: { deletedAt: null, status: { notIn: [...INACTIVE_APPOINTMENT_STATUSES] }, startsAt: { gte: start, lt: end } },
    });
  }

  private parseEntitlements(row: SubscriptionRow): Entitlements {
    const base = entitlementsSchema.safeParse(row.entitlements);
    if (!base.success) {
      this.logger.error({ plan: row.plan_code, version: row.plan_version }, 'Droits du plan invalides');
      throw new Error('Droits du plan invalides');
    }
    if (row.overrides === null || row.overrides === undefined) return base.data;
    const overrides = entitlementOverridesSchema.safeParse(row.overrides);
    if (!overrides.success) {
      this.logger.error({ subscriptionId: row.subscription_id }, 'Dérogations d’abonnement invalides');
      throw new Error('Dérogations d’abonnement invalides');
    }
    return mergeEntitlements(base.data, overrides.data);
  }
}
