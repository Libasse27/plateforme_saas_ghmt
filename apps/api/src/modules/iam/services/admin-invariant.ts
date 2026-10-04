import { TENANT_ADMIN_ROLE } from '../../../infrastructure/tenancy/tenant-provisioning.service';
import { DomainError } from '../../../common/errors/domain-error';
import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';

export interface AdminExclusion {
  readonly excludeUserId?: string;
  readonly excludeAssignmentId?: string;
}

/** Affectation « administrateur » valide : rôle non supprimé, portée établissement, non révoquée, dans sa fenêtre, utilisateur actif. */
function activeAdminWhere(now: Date, exclusion: AdminExclusion) {
  return {
    role: { code: TENANT_ADMIN_ROLE, deletedAt: null },
    scopeType: 'tenant' as const,
    revokedAt: null,
    validFrom: { lte: now },
    OR: [{ validUntil: null }, { validUntil: { gt: now } }],
    user: { status: 'active' as const, deletedAt: null },
    ...(exclusion.excludeUserId ? { userId: { not: exclusion.excludeUserId } } : {}),
    ...(exclusion.excludeAssignmentId ? { id: { not: exclusion.excludeAssignmentId } } : {}),
  };
}

export async function holdsActiveAdminRole(tx: TenantTx, userId: string, now: Date = new Date()): Promise<boolean> {
  const found = await tx.userRoleAssignment.findFirst({
    where: { ...activeAdminWhere(now, {}), userId },
    select: { userId: true },
  });
  return found !== null;
}

/**
 * Invariant docs/04 §3.6 : après l'opération, il doit rester au moins un administrateur actif.
 * Le rôle est verrouillé (FOR UPDATE) pour sérialiser deux retraits concurrents.
 */
export async function assertAnotherActiveAdmin(
  tx: TenantTx,
  tenantId: string,
  exclusion: AdminExclusion,
  now: Date = new Date(),
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM tenant.roles WHERE tenant_id = ${tenantId}::uuid AND code = ${TENANT_ADMIN_ROLE} FOR UPDATE`;
  const others = await tx.userRoleAssignment.findMany({
    where: activeAdminWhere(now, exclusion),
    select: { userId: true },
  });
  if (others.length === 0) {
    throw DomainError.conflict('last_admin', 'Le dernier administrateur actif de l’établissement ne peut pas être désactivé ni perdre son rôle.');
  }
}
