import type { ScopeType } from '@ghmt/shared';
import type { EffectiveGrant } from '../../../common/authz/authorization.types';
import { DomainError } from '../../../common/errors/domain-error';

/** Nœud de portée visé par une affectation (un service porte aussi son site pour l'héritage). */
export interface TargetScope {
  readonly type: ScopeType;
  readonly id?: string;
  readonly siteId?: string;
}

const TENANT_SCOPE: TargetScope = { type: 'tenant' };

function scopeIncludes(grant: EffectiveGrant, target: TargetScope): boolean {
  if (grant.scopeType === 'tenant') return true;
  if (grant.scopeType === 'site') {
    if (target.type === 'site') return grant.scopeId === target.id;
    return target.type === 'department' && grant.scopeId === target.siteId;
  }
  return target.type === 'department' && grant.scopeId === target.id;
}

/** L'acteur détient-il la permission sur une portée au moins égale à la cible (docs/04 §3.4 et §3.6) ? */
export function grantCovers(grants: readonly EffectiveGrant[], permission: string, target: TargetScope): boolean {
  return grants.some((g) => g.permission === permission && scopeIncludes(g, target));
}

export function missingPermissions(
  grants: readonly EffectiveGrant[],
  permissions: readonly string[],
  target: TargetScope = TENANT_SCOPE,
): string[] {
  return permissions.filter((permission) => !grantCovers(grants, permission, target));
}

export interface AssignableRole {
  readonly isSystem: boolean;
  readonly permissions: readonly string[];
}

export interface AssignmentParties {
  readonly actorUserId: string;
  readonly targetUserId: string;
  /** Permission d'affectation exigée sur la portée visée (`iam:assignment:create` ou `:delete`). */
  readonly assignmentPermission: 'iam:assignment:create' | 'iam:assignment:delete';
}

/**
 * Règle d'affectation (décision produit du 2026-10-04, docs/04 §3.6 amendé) :
 * - un rôle SYSTÈME (modèle immuable) est délégable à AUTRUI par qui détient la permission
 *   d'affectation sur la portée visée : l'admin, sans droit clinique, peut ainsi nommer un médecin ;
 * - l'auto-affectation, les rôles PERSONNALISÉS et tout rôle portant des droits d'administration
 *   en écriture (`iam:*` hors lecture, ex. tenant_admin) restent soumis à l'anti-escalade stricte :
 *   détenir `iam:assignment:create` ne permet pas de fabriquer un administrateur complice.
 */
function isAdministrativeWrite(permission: string): boolean {
  return permission.startsWith('iam:') && !permission.endsWith(':read');
}

export function isDelegableSystemRole(role: AssignableRole): boolean {
  return role.isSystem && !role.permissions.some(isAdministrativeWrite);
}

export function assertCanAssign(
  grants: readonly EffectiveGrant[],
  role: AssignableRole,
  target: TargetScope,
  parties: AssignmentParties,
): void {
  const delegatingSystemRole = isDelegableSystemRole(role) && parties.actorUserId !== parties.targetUserId;
  if (delegatingSystemRole) {
    if (!grantCovers(grants, parties.assignmentPermission, target)) {
      throw DomainError.forbidden('out_of_scope', 'Vous ne pouvez pas gérer les affectations sur cette portée.');
    }
    return;
  }
  assertNoEscalation(grants, role.permissions, target);
}

/**
 * Anti-escalade : l'acteur doit détenir TOUTES les permissions du rôle sur la portée visée.
 * Le détail des permissions manquantes n'est pas renvoyé au client.
 */
export function assertNoEscalation(
  grants: readonly EffectiveGrant[],
  permissions: readonly string[],
  target: TargetScope = TENANT_SCOPE,
): void {
  if (missingPermissions(grants, permissions, target).length > 0) {
    throw DomainError.forbidden(
      'privilege_escalation',
      'Vous ne pouvez pas accorder ou modifier des droits que vous ne détenez pas vous-même.',
    );
  }
}

/** Modules cliniques et financiers dont l'attribution est tracée à part (H2 : détection d'un administrateur complice). */
const SENSITIVE_ROLE_MODULES: ReadonlySet<string> = new Set([
  'consultations',
  'nursing',
  'maternity',
  'laboratory',
  'imaging',
  'pharmacy',
  'accounting',
  'cashier',
]);

/** Un rôle est « sensible » s'il donne accès à un module clinique ou financier. */
export function isSensitiveRole(permissions: readonly string[]): boolean {
  return permissions.some((permission) => SENSITIVE_ROLE_MODULES.has(permission.split(':')[0] ?? ''));
}
