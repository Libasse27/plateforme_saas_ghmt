import type { PermissionKey, ScopeType } from '@ghmt/shared';

/** Permission accordée par une affectation de rôle, avec sa portée (docs/04 §3.4). */
export interface EffectiveGrant {
  readonly permission: PermissionKey;
  readonly scopeType: ScopeType;
  /** NULL pour la portée établissement (tout le tenant). */
  readonly scopeId: string | null;
  readonly mfaRequired: boolean;
}

export type TenantStatus = 'pending' | 'active' | 'suspended' | 'terminated';

export type DenyReason =
  | 'tenant_inactive'
  | 'subscription_suspended'
  | 'module_not_enabled'
  | 'permission_denied'
  | 'mfa_enrollment_required'
  | 'password_change_required';

export type AuthorizationDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: DenyReason; readonly permission?: PermissionKey };

export interface AuthorizationInput {
  readonly required: readonly PermissionKey[];
  readonly grants: readonly EffectiveGrant[];
  readonly enabledModules: ReadonlySet<string>;
  readonly tenantStatus: TenantStatus | undefined;
  readonly mfaVerified: boolean;
}
