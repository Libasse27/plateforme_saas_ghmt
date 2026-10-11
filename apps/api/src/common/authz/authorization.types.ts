import type { ClinicalMfaMode, PermissionKey, ScopeType, SubscriptionStatus } from '@ghmt/shared';

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
  | 'subscription_grace'
  | 'module_not_enabled'
  | 'permission_denied'
  | 'mfa_enrollment_required'
  | 'password_change_required';

export type AuthorizationDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: DenyReason; readonly permission?: PermissionKey; readonly offNetwork?: boolean };

export interface AuthorizationInput {
  readonly required: readonly PermissionKey[];
  readonly grants: readonly EffectiveGrant[];
  readonly enabledModules: ReadonlySet<string>;
  readonly tenantStatus: TenantStatus | undefined;
  readonly mfaVerified: boolean;
  /** L'IP cliente de cette requête appartient-elle à une plage de confiance active (évaluée à chaque requête, docs/11 D4) ? */
  readonly networkTrusted: boolean;
  readonly clinicalMfaMode: ClinicalMfaMode;
  /** Statut de l'abonnement du tenant (absent pour un tenant historique sans abonnement : aucune restriction). */
  readonly subscriptionStatus?: SubscriptionStatus | undefined;
  /** Route explicitement autorisée en lecture seule (ex. paiement de l'abonnement) : lève la restriction « suspendu ». */
  readonly allowWhenSuspended?: boolean;
}
