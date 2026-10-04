import { Injectable } from '@nestjs/common';
import type { Plan, Subscription } from '../../../generated/prisma/client';
import type { PlatformTx } from '../../../infrastructure/prisma/platform-db.service';

/** Pays de repli de l'entité de facturation quand le pays du tenant n'a pas d'entité dédiée. */
export const FALLBACK_BILLING_COUNTRY = 'ZZ';

export interface TenantBillingInfo {
  readonly id: string;
  readonly countryCode: string;
  readonly baseCurrency: string;
  readonly status: string;
}

export interface BillingEntityInfo {
  readonly countryCode: string;
  readonly taxRate: string;
}

export interface TenantUsageRow {
  readonly tenantId: string;
  readonly users: number;
  readonly sites: number;
  readonly patients: number;
  readonly appointmentsMonth: number;
  readonly appointments30d: number;
}

/** Accès aux tables d'abonnement (rôle ghmt_platform uniquement). Les verrous de ligne sérialisent les écritures concurrentes. */
@Injectable()
export class SubscriptionsRepository {
  /** Verrouille la ligne d'abonnement (FOR UPDATE) puis la relit : base de toute transition. */
  async lockById(tx: PlatformTx, id: string): Promise<Subscription | null> {
    await tx.$queryRaw`SELECT id FROM platform.subscriptions WHERE id = ${id}::uuid FOR UPDATE`;
    return tx.subscription.findUnique({ where: { id } });
  }

  async lockByTenant(tx: PlatformTx, tenantId: string): Promise<Subscription | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM platform.subscriptions WHERE tenant_id = ${tenantId}::uuid FOR UPDATE`;
    const row = rows[0];
    return row ? tx.subscription.findUnique({ where: { id: row.id } }) : null;
  }

  findPlan(tx: PlatformTx, id: string): Promise<Plan | null> {
    return tx.plan.findUnique({ where: { id } });
  }

  /** Dernière version non archivée d'un plan. */
  latestPlanByCode(tx: PlatformTx, code: string): Promise<Plan | null> {
    return tx.plan.findFirst({ where: { code, archivedAt: null }, orderBy: { version: 'desc' } });
  }

  async tenantBillingInfo(tx: PlatformTx, tenantId: string): Promise<TenantBillingInfo | null> {
    const tenant = await tx.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      select: { id: true, countryCode: true, baseCurrency: true, status: true },
    });
    return tenant ? { id: tenant.id, countryCode: tenant.countryCode.trim(), baseCurrency: tenant.baseCurrency.trim(), status: tenant.status } : null;
  }

  async billingEntityFor(tx: PlatformTx, countryCode: string): Promise<BillingEntityInfo> {
    const entity =
      (await tx.billingEntity.findUnique({ where: { countryCode } })) ??
      (await tx.billingEntity.findUnique({ where: { countryCode: FALLBACK_BILLING_COUNTRY } }));
    if (!entity) throw new Error('Aucune entité de facturation (exécutez le seed)');
    return { countryCode: entity.countryCode.trim(), taxRate: entity.taxRate.toFixed(4) };
  }

  /** Décomptes d'usage via la fonction SECURITY DEFINER (comptes uniquement, aucune donnée patient). */
  async usageOf(tx: PlatformTx, tenantIds: readonly string[] | null, now: Date): Promise<TenantUsageRow[]> {
    const rows = await tx.$queryRaw<
      { tenant_id: string; users: number; sites: number; patients: number; appointments_month: number; appointments_30d: number }[]
    >`SELECT tenant_id::text AS tenant_id, users, sites, patients, appointments_month, appointments_30d
      FROM platform.tenants_usage(${tenantIds === null ? null : [...tenantIds]}::uuid[], ${now}::timestamptz)`;
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      users: r.users,
      sites: r.sites,
      patients: r.patients,
      appointmentsMonth: r.appointments_month,
      appointments30d: r.appointments_30d,
    }));
  }
}
