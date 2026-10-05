import { Injectable } from '@nestjs/common';
import type { ListPlatformTenantsQuery, PlatformTenantDetail, PlatformTenantSummary, SuspendTenantInput } from '@ghmt/shared';
import { PlatformAuditService } from '../../../common/audit/platform-audit.service';
import { DomainError } from '../../../common/errors/domain-error';
import { Page, decodeUuidCursor } from '../../../common/pagination/page';
import { Clock } from '../../../common/time/clock';
import type { Plan, Subscription, Tenant } from '../../../generated/prisma/client';
import { PlatformDb } from '../../../infrastructure/prisma/platform-db.service';
import { SubscriptionsRepository } from '../../subscriptions/repositories/subscriptions.repository';
import type { PlatformPrincipal } from '../auth/platform-auth.guard';
import { actorOf } from './platform-actor';
import { PlatformSubscriptionsService } from './platform-subscriptions.service';

/** Statuts d'abonnement pour lesquels l'établissement est en lecture seule (miroir de SubscriptionStateService). */
const READ_ONLY_SUBSCRIPTION_STATUSES = ['suspended', 'expired'];

function toSummary(tenant: Tenant, subscription: Subscription | undefined, plan: Plan | undefined): PlatformTenantSummary {
  return {
    id: tenant.id,
    slug: tenant.slug,
    name: tenant.legalName,
    establishmentType: tenant.establishmentType,
    countryCode: tenant.countryCode.trim(),
    status: tenant.status,
    createdAt: tenant.createdAt.toISOString(),
    subscription:
      subscription && plan
        ? { status: subscription.status, planCode: plan.code, currentPeriodEnd: subscription.currentPeriodEnd.toISOString() }
        : null,
  };
}

/** Établissements vus par la console : liste, détail avec usage agrégé (comptes), suspension et réactivation motivées. */
@Injectable()
export class PlatformTenantsService {
  constructor(
    private readonly platformDb: PlatformDb,
    private readonly repository: SubscriptionsRepository,
    private readonly subscriptions: PlatformSubscriptionsService,
    private readonly audit: PlatformAuditService,
    private readonly clock: Clock,
  ) {}

  list(query: ListPlatformTenantsQuery): Promise<Page<PlatformTenantSummary>> {
    const after = decodeUuidCursor(query.cursor);
    return this.platformDb.run(async (tx) => {
      const restrictTo = query.subscriptionStatus
        ? (await tx.subscription.findMany({ where: { status: query.subscriptionStatus }, select: { tenantId: true } })).map((s) => s.tenantId)
        : undefined;
      const tenants = await tx.tenant.findMany({
        where: {
          deletedAt: null,
          ...(query.status ? { status: query.status } : {}),
          ...(restrictTo ? { id: { in: restrictTo } } : {}),
          ...(after ? { id: { lt: after, ...(restrictTo ? { in: restrictTo } : {}) } } : {}),
          ...(query.q
            ? { OR: [{ slug: { contains: query.q, mode: 'insensitive' as const } }, { legalName: { contains: query.q, mode: 'insensitive' as const } }] }
            : {}),
        },
        orderBy: { id: 'desc' },
        take: query.limit + 1,
      });
      const ids = tenants.map((t) => t.id);
      const subs = await tx.subscription.findMany({ where: { tenantId: { in: ids } } });
      const plans = await tx.plan.findMany({ where: { id: { in: subs.map((s) => s.planId) } } });
      const subByTenant = new Map(subs.map((s) => [s.tenantId, s]));
      const planById = new Map(plans.map((p) => [p.id, p]));
      return Page.fromRows(
        tenants,
        query.limit,
        (t) => {
          const sub = subByTenant.get(t.id);
          return toSummary(t, sub, sub ? planById.get(sub.planId) : undefined);
        },
        (t) => t.id,
      );
    });
  }

  detail(tenantId: string): Promise<PlatformTenantDetail> {
    const now = this.clock.now();
    return this.platformDb.run(async (tx) => {
      const tenant = await tx.tenant.findFirst({ where: { id: tenantId, deletedAt: null } });
      if (!tenant) throw DomainError.notFound('Établissement');
      const subscription = await this.subscriptions.viewIn(tx, tenantId, now);
      const [usage] = await this.repository.usageOf(tx, [tenantId]);
      const modules = await tx.tenantModule.findMany({ where: { tenantId, disabledAt: null }, select: { moduleCode: true }, orderBy: { moduleCode: 'asc' } });
      const [open, overdue] = await Promise.all([
        tx.saasInvoice.count({ where: { tenantId, status: 'open' } }),
        tx.saasInvoice.count({ where: { tenantId, status: 'open', dueAt: { lt: now } } }),
      ]);
      return {
        tenant: {
          ...toSummary(tenant, undefined, undefined),
          subscription: subscription
            ? { status: subscription.status, planCode: subscription.plan.code, currentPeriodEnd: subscription.currentPeriodEnd }
            : null,
          legalName: tenant.legalName,
          baseCurrency: tenant.baseCurrency.trim(),
          timezone: tenant.timezone,
          suspensionReason: subscription?.suspensionReason ?? null,
        },
        subscription,
        usage: {
          users: usage?.users ?? 0,
          sites: usage?.sites ?? 0,
          patients: usage?.patients ?? 0,
          appointmentsThisMonth: usage?.appointmentsMonth ?? 0,
          appointmentsLast30Days: usage?.appointments30d ?? 0,
        },
        modules: modules.map((m) => m.moduleCode),
        invoices: { open, overdue },
      };
    });
  }

  /** Suspension décidée par la plateforme : lecture seule immédiate, motif conservé (un paiement ne la lève pas). */
  async suspend(tenantId: string, input: SuspendTenantInput, principal: PlatformPrincipal): Promise<PlatformTenantDetail> {
    await this.platformDb.run(async (tx) => {
      const subscription = await this.repository.lockByTenant(tx, tenantId);
      const tenant = await tx.tenant.findFirst({ where: { id: tenantId, deletedAt: null }, select: { id: true, status: true } });
      if (!tenant || !subscription) throw DomainError.notFound('Établissement');
      if (subscription.manualSuspensionReason !== null) {
        throw DomainError.conflict('already_suspended', 'Cet établissement est déjà suspendu par la plateforme.');
      }
      if (tenant.status !== 'active' && tenant.status !== 'suspended') {
        throw DomainError.conflict('invalid_state', 'Seul un établissement actif peut être suspendu.');
      }
      await tx.subscription.update({ where: { id: subscription.id }, data: { manualSuspensionReason: input.reason } });
      await tx.tenant.update({ where: { id: tenantId }, data: { status: 'suspended' } });
      await this.audit.record(tx, {
        action: 'tenant.suspended',
        actor: actorOf(principal),
        resourceType: 'tenant',
        resourceId: tenantId,
        tenantId,
        changes: { reason: input.reason },
      });
    });
    return this.detail(tenantId);
  }

  /** Lève la suspension manuelle ; l'établissement reste en lecture seule si l'abonnement est lui-même suspendu ou expiré. */
  async reactivate(tenantId: string, principal: PlatformPrincipal): Promise<PlatformTenantDetail> {
    await this.platformDb.run(async (tx) => {
      const subscription = await this.repository.lockByTenant(tx, tenantId);
      if (!subscription) throw DomainError.notFound('Établissement');
      if (subscription.manualSuspensionReason === null) {
        throw DomainError.conflict('not_manually_suspended', 'Cet établissement n’est pas suspendu par la plateforme.');
      }
      const stillReadOnly = READ_ONLY_SUBSCRIPTION_STATUSES.includes(subscription.status);
      await tx.subscription.update({ where: { id: subscription.id }, data: { manualSuspensionReason: null } });
      if (!stillReadOnly) await tx.tenant.updateMany({ where: { id: tenantId, status: 'suspended' }, data: { status: 'active' } });
      await this.audit.record(tx, {
        action: 'tenant.reactivated',
        actor: actorOf(principal),
        resourceType: 'tenant',
        resourceId: tenantId,
        tenantId,
        changes: { stillReadOnly },
      });
    });
    return this.detail(tenantId);
  }
}
