import { Injectable } from '@nestjs/common';
import { isPermissionKey, moduleOf, type PermissionKey, type SubscriptionStatus } from '@ghmt/shared';
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
/**
 * Écritures qui restent autorisées quand le tenant est en mode « continuité » (suspendu, résilié ou expiré ; docs/05 A6,
 * docs/09 §A3 et §R) : enregistrer un patient (urgence), facturer, encaisser (sessions de caisse comprises) et mettre à jour
 * un rendez-vous (arrivée du patient). Règle durable : un impayé ne bloque jamais l'accueil, la facturation ni la saisie clinique.
 */
const SUSPENDED_ALLOWED_WRITES: ReadonlySet<string> = new Set([
  'patients:patient:create',
  'billing:invoice:create',
  'cashier:payment:create',
  'cashier:cash_session:create',
  'cashier:cash_session:validate',
  'appointments:appointment:update',
]);

/** Actions sans effet sur les données : permises en suspension (l'administrateur doit pouvoir exporter et imprimer). */
const SUSPENDED_ALLOWED_ACTIONS: ReadonlySet<string> = new Set(['read', 'print', 'export']);

/** Actions administratives non essentielles bloquées en période de grâce : création/invitation d'utilisateurs et exports de masse. */
const GRACE_BLOCKED_PERMISSIONS: ReadonlySet<string> = new Set(['iam:user:create', 'iam:invitation:create']);

/** Exports relevant des droits du patient (accès et portabilité) : jamais bloqués par un impayé. */
const GRACE_ALLOWED_EXPORTS: ReadonlySet<string> = new Set(['patients:patient:export', 'consultations:medical_record:export']);

function isRestrictedInSuspension(permission: PermissionKey): boolean {
  const action = permission.slice(permission.lastIndexOf(':') + 1);
  return !SUSPENDED_ALLOWED_ACTIONS.has(action) && !SUSPENDED_ALLOWED_WRITES.has(permission);
}

function isBlockedInGrace(permission: PermissionKey): boolean {
  if (GRACE_ALLOWED_EXPORTS.has(permission)) return false;
  return GRACE_BLOCKED_PERMISSIONS.has(permission) || permission.endsWith(':export');
}

export function evaluateAuthorization(input: AuthorizationInput): AuthorizationDecision {
  const { required, grants, enabledModules, tenantStatus, mfaVerified, subscriptionStatus, allowWhenSuspended } = input;
  if (tenantStatus !== 'active' && tenantStatus !== 'suspended') return { allowed: false, reason: 'tenant_inactive' };

  for (const permission of required) {
    if (tenantStatus === 'suspended' && !allowWhenSuspended && isRestrictedInSuspension(permission)) {
      return { allowed: false, reason: 'subscription_suspended', permission };
    }
    if (subscriptionStatus === 'grace' && isBlockedInGrace(permission)) return { allowed: false, reason: 'subscription_grace', permission };
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

  /** Statut de l'abonnement du tenant courant (fonction SECURITY DEFINER) ; `undefined` si le tenant n'a pas d'abonnement. */
  async loadSubscriptionStatus(tx: TenantTx): Promise<SubscriptionStatus | undefined> {
    const rows = await tx.$queryRaw<{ status: SubscriptionStatus }[]>`SELECT status FROM platform.current_tenant_subscription()`;
    return rows[0]?.status;
  }

  /** Modules actifs et statut du tenant courant (fonction SECURITY DEFINER, tenant lu dans le contexte). */
  async loadTenantModules(tx: TenantTx): Promise<{ modules: Set<string>; status: TenantStatus | undefined }> {
    const rows = await tx.$queryRaw<{ module_code: string; tenant_status: TenantStatus }[]>`
      SELECT module_code, tenant_status::text AS tenant_status FROM platform.current_tenant_modules()`;
    return { modules: new Set(rows.map((r) => r.module_code)), status: rows[0]?.tenant_status };
  }
}
