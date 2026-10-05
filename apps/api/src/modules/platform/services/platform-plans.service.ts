import { Injectable } from '@nestjs/common';
import type { CreatePlanVersionInput, PlatformPlanView } from '@ghmt/shared';
import { entitlementsSchema } from '@ghmt/shared';
import { PlatformAuditService } from '../../../common/audit/platform-audit.service';
import { DomainError } from '../../../common/errors/domain-error';
import { Clock } from '../../../common/time/clock';
import { Prisma, type Plan } from '../../../generated/prisma/client';
import { PlatformDb } from '../../../infrastructure/prisma/platform-db.service';
import { toPlanSummary } from '../../subscriptions/mappers/subscription.mapper';
import type { PlatformPrincipal } from '../auth/platform-auth.guard';
import { actorOf } from './platform-actor';

/** Modules que tous les plans doivent inclure (docs/09 §A2). */
const REQUIRED_PLAN_MODULES = ['billing', 'cashier'] as const;

function toView(plan: Plan): PlatformPlanView {
  return {
    ...toPlanSummary(plan),
    isPublic: plan.isPublic,
    archivedAt: plan.archivedAt?.toISOString() ?? null,
    createdAt: plan.createdAt.toISOString(),
    entitlements: entitlementsSchema.parse(plan.entitlements),
  };
}

/** Catalogue des plans (versionné) : les versions publiées sont immuables, une évolution crée une nouvelle version. */
@Injectable()
export class PlatformPlansService {
  constructor(
    private readonly platformDb: PlatformDb,
    private readonly audit: PlatformAuditService,
    private readonly clock: Clock,
  ) {}

  async list(includeArchived: boolean): Promise<PlatformPlanView[]> {
    const plans = await this.platformDb.run((tx) =>
      tx.plan.findMany({ where: includeArchived ? {} : { archivedAt: null }, orderBy: [{ code: 'asc' }, { version: 'desc' }] }),
    );
    return plans.map(toView);
  }

  /** Crée la version suivante d'un code de plan (ou la version 1 d'un nouveau code) et archive la précédente. */
  async createVersion(input: CreatePlanVersionInput, principal: PlatformPrincipal): Promise<PlatformPlanView> {
    const now = this.clock.now();
    try {
      const created = await this.platformDb.run(async (tx) => {
        await this.assertModulesValid(tx, input.entitlements.modules);
        // Sérialise les créations concurrentes d'un même code (la contrainte UNIQUE (code, version) reste le filet).
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`plan:${input.code}`}, 0))`;
        const latest = await tx.plan.findFirst({ where: { code: input.code }, orderBy: { version: 'desc' } });
        const plan = await tx.plan.create({
          data: {
            code: input.code,
            version: (latest?.version ?? 0) + 1,
            name: input.name,
            tier: input.tier,
            priceMonthly: input.priceMonthly,
            priceYearly: input.priceYearly,
            currency: input.currency,
            entitlements: input.entitlements,
            isPublic: input.isPublic,
          },
        });
        if (latest) await tx.plan.updateMany({ where: { code: input.code, version: { lt: plan.version }, archivedAt: null }, data: { archivedAt: now } });
        await this.audit.record(tx, {
          action: 'plan.version_created',
          actor: actorOf(principal),
          resourceType: 'plan',
          resourceId: plan.id,
          changes: { code: plan.code, version: plan.version, priceMonthly: input.priceMonthly, priceYearly: input.priceYearly, currency: input.currency },
        });
        return plan;
      });
      return toView(created);
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw DomainError.conflict('plan_version_conflict', 'Une autre version de ce plan vient d’être créée, réessayez.');
      }
      throw error;
    }
  }

  private async assertModulesValid(tx: Prisma.TransactionClient, modules: readonly string[]): Promise<void> {
    const missing = REQUIRED_PLAN_MODULES.filter((m) => !modules.includes(m));
    if (missing.length > 0) {
      throw DomainError.validation([{ path: 'entitlements.modules', code: 'required_modules', message: `Modules obligatoires : ${missing.join(', ')}.` }]);
    }
    const known = new Set((await tx.module.findMany({ select: { code: true } })).map((m) => m.code));
    const unknown = modules.filter((m) => !known.has(m));
    if (unknown.length > 0) {
      throw DomainError.validation([{ path: 'entitlements.modules', code: 'unknown_module', message: `Modules inconnus : ${unknown.join(', ')}.` }]);
    }
  }
}
