import { Injectable } from '@nestjs/common';
import { entitlementOverridesSchema, entitlementsSchema, mergeEntitlements } from '@ghmt/shared';
import type { Plan, Subscription } from '../../../generated/prisma/client';
import type { PlatformTx } from '../../../infrastructure/prisma/platform-db.service';

/** Droits effectifs d'un abonnement : plan ⊕ dérogations. Lève si le JSON stocké est invalide. */
export function effectiveEntitlements(plan: Pick<Plan, 'entitlements'>, subscription: Pick<Subscription, 'overrides'>) {
  const base = entitlementsSchema.parse(plan.entitlements);
  const overrides = subscription.overrides === null ? null : entitlementOverridesSchema.parse(subscription.overrides);
  return mergeEntitlements(base, overrides);
}

/**
 * Synchronise `platform.tenant_modules` avec les modules des droits effectifs (docs/09 §A2) :
 * modules du plan activés, autres modules optionnels désactivés. Les modules « core » ne sont jamais touchés.
 */
@Injectable()
export class TenantModulesSync {
  async sync(tx: PlatformTx, tenantId: string, plan: Plan, subscription: Subscription, now: Date): Promise<void> {
    const wanted = new Set(effectiveEntitlements(plan, subscription).modules);
    const optional = await tx.module.findMany({ where: { isCore: false }, select: { code: true } });
    for (const { code } of optional) {
      if (wanted.has(code)) {
        await tx.tenantModule.upsert({
          where: { tenantId_moduleCode: { tenantId, moduleCode: code } },
          create: { tenantId, moduleCode: code, enabledAt: now },
          update: { disabledAt: null },
        });
      } else {
        await tx.tenantModule.updateMany({ where: { tenantId, moduleCode: code, disabledAt: null }, data: { disabledAt: now } });
      }
    }
  }
}
