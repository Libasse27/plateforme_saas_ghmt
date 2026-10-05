import { Injectable } from '@nestjs/common';
import { ROLE_TEMPLATES, TRIAL_DAYS, permissionsForTemplate, trialPlanCodeFor, type SignupTenantInput } from '@ghmt/shared';
import { AuditService } from '../../common/audit/audit.service';
import { Clock } from '../../common/time/clock';
import { TenantDb, applyTenantContext, type TenantTx } from '../prisma/tenant-db.service';

export const TENANT_ADMIN_ROLE = 'tenant_admin';
/**
 * Modules optionnels activés par défaut à l'inscription (les modules « core » le sont toujours).
 * Tous les plans incluent la facturation et la caisse (docs/09 §A2).
 */
export const DEFAULT_OPTIONAL_MODULES: readonly string[] = ['appointments', 'billing', 'cashier'];

export interface ProvisionedTenant {
  readonly tenantId: string;
  readonly adminUserId: string;
  readonly mainSiteId: string;
}

/**
 * Création atomique d'un établissement (docs/05 A11) : tenant + modules (fonction SECURITY DEFINER),
 * site principal, rôles système clonés depuis les modèles, administrateur et son affectation,
 * essai de 30 jours (docs/09 §A3). Tout ou rien : une seule transaction.
 */
@Injectable()
export class TenantProvisioningService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  provision(
    input: SignupTenantInput,
    adminPasswordHash: string,
    optionalModules: readonly string[] = DEFAULT_OPTIONAL_MODULES,
  ): Promise<ProvisionedTenant> {
    const { establishment: e } = input;
    return this.tenantDb.runWithoutTenant(async (tx) => {
      const [registered] = await tx.$queryRaw<{ id: string }[]>`
        SELECT platform.register_tenant(
          ${e.slug}, ${e.legalName}, ${e.tradeName ?? null},
          ${e.establishmentType}::platform.establishment_type,
          ${e.countryCode}::char(2), ${e.baseCurrency}::char(3), ${e.timezone},
          ${[...optionalModules]}::text[]
        )::text AS id`;
      const tenantId = registered!.id;
      await applyTenantContext(tx, tenantId);
      const trialPlan = trialPlanCodeFor(e.establishmentType);
      await tx.$queryRaw`SELECT platform.start_trial(${trialPlan}, ${TRIAL_DAYS}::int, ${this.clock.now()}::timestamptz)`;

      const site = await tx.site.create({
        data: { tenantId, code: input.mainSite.code, name: input.mainSite.name, city: input.mainSite.city, isMain: true },
        select: { id: true },
      });
      const roleIds = await this.cloneSystemRoles(tx, tenantId);

      const admin = await tx.user.create({
        data: {
          tenantId,
          email: input.admin.email,
          fullName: input.admin.fullName,
          status: 'active',
          credential: { create: { passwordHash: adminPasswordHash } },
        },
        select: { id: true },
      });
      await tx.userRoleAssignment.create({
        data: { tenantId, userId: admin.id, roleId: roleIds.get(TENANT_ADMIN_ROLE)!, scopeType: 'tenant' },
      });

      await this.audit.record(tx, tenantId, {
        action: 'tenant.provisioned',
        actorType: 'user',
        actorUserId: admin.id,
        resourceType: 'tenant',
        resourceId: tenantId,
        changes: { slug: e.slug, establishmentType: e.establishmentType, modules: [...optionalModules], trialPlan },
      });
      return { tenantId, adminUserId: admin.id, mainSiteId: site.id };
    });
  }

  private async cloneSystemRoles(tx: TenantTx, tenantId: string): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    for (const template of ROLE_TEMPLATES) {
      const role = await tx.role.create({
        data: {
          tenantId,
          code: template.code,
          name: template.name,
          description: template.description,
          isSystem: true,
          templateCode: template.code,
          mfaRequired: template.mfaRequired,
        },
        select: { id: true },
      });
      await tx.rolePermission.createMany({
        data: permissionsForTemplate(template).map((permissionCode) => ({ tenantId, roleId: role.id, permissionCode })),
      });
      ids.set(template.code, role.id);
    }
    return ids;
  }
}
