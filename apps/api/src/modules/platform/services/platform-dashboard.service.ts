import { Injectable } from '@nestjs/common';
import type { PlatformDashboard } from '@ghmt/shared';
import { Clock } from '../../../common/time/clock';
import { PlatformDb } from '../../../infrastructure/prisma/platform-db.service';
import { fromMinor, toMinor } from '../../subscriptions/domain/money';
import { SubscriptionsRepository } from '../../subscriptions/repositories/subscriptions.repository';

/** Abonnements qui génèrent du revenu récurrent (un impayé en cours reste compté jusqu'à la suspension). */
const REVENUE_STATUSES = ['active', 'past_due', 'grace'] as const;
const MONTHS_PER_YEAR = 12n;

/** Tableau de bord de la console (docs/09 §A5) : comptes, MRR/ARR par devise, factures en retard. */
@Injectable()
export class PlatformDashboardService {
  constructor(
    private readonly platformDb: PlatformDb,
    private readonly repository: SubscriptionsRepository,
    private readonly clock: Clock,
  ) {}

  get(): Promise<PlatformDashboard> {
    const now = this.clock.now();
    return this.platformDb.run(async (tx) => {
      const [tenantGroups, trial, overdue, usage, revenueGroups] = await Promise.all([
        tx.tenant.groupBy({ by: ['status'], where: { deletedAt: null }, _count: { _all: true } }),
        tx.subscription.count({ where: { status: 'trial' } }),
        tx.saasInvoice.count({ where: { status: 'open', dueAt: { lt: now } } }),
        this.repository.usageOf(tx, null, now),
        tx.subscription.groupBy({ by: ['planId', 'billingPeriod'], where: { status: { in: [...REVENUE_STATUSES] } }, _count: { _all: true } }),
      ]);
      const plans = await tx.plan.findMany({ where: { id: { in: revenueGroups.map((g) => g.planId) } } });
      const planById = new Map(plans.map((p) => [p.id, p]));

      // ARR en unités mineures par devise : mensuel × 12, annuel tel quel ; MRR = ARR / 12 (arrondi à la demi-unité).
      const arrMinor = new Map<string, bigint>();
      for (const group of revenueGroups) {
        const plan = planById.get(group.planId);
        if (!plan) continue;
        const unit = group.billingPeriod === 'monthly' ? toMinor(plan.priceMonthly.toFixed(2)) * MONTHS_PER_YEAR : toMinor(plan.priceYearly.toFixed(2));
        const currency = plan.currency.trim();
        arrMinor.set(currency, (arrMinor.get(currency) ?? 0n) + unit * BigInt(group._count._all));
      }
      const count = (status: string): number => tenantGroups.find((g) => g.status === status)?._count._all ?? 0;
      return {
        tenants: {
          total: tenantGroups.reduce((sum, g) => sum + g._count._all, 0),
          active: count('active'),
          trial,
          suspended: count('suspended'),
        },
        users: usage.reduce((sum, row) => sum + row.users, 0),
        patients: usage.reduce((sum, row) => sum + row.patients, 0),
        appointmentsLast30Days: usage.reduce((sum, row) => sum + row.appointments30d, 0),
        mrr: Object.fromEntries([...arrMinor].map(([currency, arr]) => [currency, fromMinor((arr * 2n + MONTHS_PER_YEAR) / (MONTHS_PER_YEAR * 2n))])),
        arr: Object.fromEntries([...arrMinor].map(([currency, arr]) => [currency, fromMinor(arr)])),
        overdueInvoices: overdue,
      };
    });
  }
}
