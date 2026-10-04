import { Injectable } from '@nestjs/common';
import { isPermissionKey, moduleOf, type PermissionKey } from '@ghmt/shared';
import type { TenantTx } from '../../infrastructure/prisma/tenant-db.service';
import type {
  AuthorizationDecision,
  AuthorizationInput,
  EffectiveGrant,
  TenantStatus,
} from './authorization.types';

/**
 * Évaluation pure (docs/04 §3.8, étapes 1 à 4) : statut du tenant, module souscrit,
 * permission présente, MFA exigée par un rôle. Toutes les permissions requises doivent être détenues.
 */
export function evaluateAuthorization(input: AuthorizationInput): AuthorizationDecision {
  const { required, grants, enabledModules, tenantStatus, mfaVerified } = input;
  if (tenantStatus !== 'active' && tenantStatus !== 'suspended') return { allowed: false, reason: 'tenant_inactive' };

  for (const permission of required) {
    const isRead = permission.endsWith(':read');
    if (tenantStatus === 'suspended' && !isRead) return { allowed: false, reason: 'subscription_suspended', permission };
    if (!enabledModules.has(moduleOf(permission))) return { allowed: false, reason: 'module_not_enabled', permission };
    if (!grants.some((g) => g.permission === permission)) return { allowed: false, reason: 'permission_denied', permission };
  }

  const mfaRequired = grants.some((g) => g.mfaRequired);
  if (mfaRequired && !mfaVerified) return { allowed: false, reason: 'mfa_enrollment_required' };
  return { allowed: true };
}

/**
 * Portées sur lesquelles une permission est détenue. `null` = tout le tenant.
 * Les services filtrent les listes avec ce résultat (ex. sites autorisés).
 */
export function scopesFor(
  permission: PermissionKey,
  grants: readonly EffectiveGrant[],
): { readonly allTenant: boolean; readonly siteIds: readonly string[]; readonly departmentIds: readonly string[] } {
  const matching = grants.filter((g) => g.permission === permission);
  return {
    allTenant: matching.some((g) => g.scopeType === 'tenant'),
    siteIds: [...new Set(matching.filter((g) => g.scopeType === 'site').map((g) => g.scopeId!))],
    departmentIds: [...new Set(matching.filter((g) => g.scopeType === 'department').map((g) => g.scopeId!))],
  };
}

@Injectable()
export class AuthorizationService {
  /** Permissions effectives : affectations valides (non révoquées, dans leur fenêtre) × permissions du rôle. */
  async loadGrants(tx: TenantTx, userId: string, now: Date = new Date()): Promise<EffectiveGrant[]> {
    const assignments = await tx.userRoleAssignment.findMany({
      where: {
        userId,
        revokedAt: null,
        validFrom: { lte: now },
        OR: [{ validUntil: null }, { validUntil: { gt: now } }],
        role: { deletedAt: null },
      },
      select: {
        scopeType: true,
        scopeId: true,
        role: { select: { mfaRequired: true, permissions: { select: { permissionCode: true } } } },
      },
    });
    return assignments.flatMap((a) =>
      a.role.permissions
        .map((p) => p.permissionCode)
        .filter(isPermissionKey)
        .map((permission) => ({ permission, scopeType: a.scopeType, scopeId: a.scopeId, mfaRequired: a.role.mfaRequired })),
    );
  }

  /** Modules actifs et statut du tenant courant (fonction SECURITY DEFINER, tenant lu dans le contexte). */
  async loadTenantModules(tx: TenantTx): Promise<{ modules: Set<string>; status: TenantStatus | undefined }> {
    const rows = await tx.$queryRaw<{ module_code: string; tenant_status: TenantStatus }[]>`
      SELECT module_code, tenant_status::text AS tenant_status FROM platform.current_tenant_modules()`;
    return { modules: new Set(rows.map((r) => r.module_code)), status: rows[0]?.tenant_status };
  }
}
