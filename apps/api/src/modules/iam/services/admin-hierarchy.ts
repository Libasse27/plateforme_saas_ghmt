import { DomainError } from '../../../common/errors/domain-error';
import { isAdministrativeWrite } from './privilege';

/** 2 : administrateur principal ; 1 : titulaire d'un rôle d'administration en écriture ; 0 : autres (docs/11 D9). */
export type AdminRank = 0 | 1 | 2;

export interface RankedUser {
  readonly userId: string;
  readonly rank: AdminRank;
}

export function adminRank(user: { readonly isOwner: boolean; readonly permissions: readonly string[] }): AdminRank {
  if (user.isOwner) return 2;
  return user.permissions.some(isAdministrativeWrite) ? 1 : 0;
}

/**
 * Toute action sur un AUTRE utilisateur de rang ≥ 1 exige `rang(acteur) > rang(cible)`. Un administrateur non principal
 * ne peut donc rien contre un autre administrateur, ni le principal contre un autre principal (il n'y en a qu'un).
 */
export function assertCanManage(actor: RankedUser, target: RankedUser): void {
  if (actor.userId === target.userId) return;
  if (target.rank >= 1 && actor.rank <= target.rank) {
    throw DomainError.forbidden('admin_hierarchy', 'Seul l’administrateur principal peut agir sur un autre administrateur.');
  }
}

/** Accorder un rôle d'administration en écriture (affectation ou invitation) est réservé au principal. */
export function assertCanGrantRole(actorRank: AdminRank, rolePermissions: readonly string[]): void {
  if (actorRank < 2 && rolePermissions.some(isAdministrativeWrite)) {
    throw DomainError.forbidden('owner_required', 'Seul l’administrateur principal peut accorder un rôle d’administration.');
  }
}

/** Le principal ne peut ni se désactiver ni perdre son rôle `tenant_admin` avant d'avoir transféré le titre. */
export function ownerMustTransfer(): DomainError {
  return DomainError.conflict('owner_must_transfer', 'L’administrateur principal doit d’abord transférer ce titre à un autre administrateur.');
}

export interface RolePermissionChange {
  /** Création d'un rôle. */
  readonly isNew?: boolean;
  /** Le rôle a au moins une affectation active. */
  readonly assigned: boolean;
  readonly before: readonly string[];
  readonly after: readonly string[];
}

/**
 * H3 (docs/11 §14.1) : ajouter une permission d'administration en écriture à un rôle affecté (ou en créer un qui en porte)
 * est réservé au principal ; sinon un administrateur promouvrait les titulaires du rôle sans passer par l'affectation.
 */
export function assertCanEditRolePermissions(actorRank: AdminRank, change: RolePermissionChange): void {
  if (actorRank >= 2 || (!change.isNew && !change.assigned)) return;
  const previous = new Set(change.before);
  if (change.after.some((permission) => !previous.has(permission) && isAdministrativeWrite(permission))) {
    throw DomainError.forbidden('owner_required', 'Seul l’administrateur principal peut ajouter un droit d’administration à ce rôle.');
  }
}
