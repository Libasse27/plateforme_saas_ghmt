import { DIRECTOR_ROLE } from '../../../common/authz/director-role';
import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';

export { isDirectorRole } from '../../../common/authz/director-role';

/** Révoque toutes les sessions actives d'un utilisateur ; renvoie leur nombre. */
export async function revokeAllSessions(tx: TenantTx, userId: string, reason: string, now: Date = new Date()): Promise<number> {
  const result = await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now, revokedReason: reason } });
  return result.count;
}

/** L'utilisateur détient-il une affectation valide de directeur à portée établissement ? */
export async function holdsDirectorRole(tx: TenantTx, userId: string, now: Date = new Date()): Promise<boolean> {
  const found = await tx.userRoleAssignment.findFirst({
    where: {
      userId,
      scopeType: 'tenant',
      revokedAt: null,
      validFrom: { lte: now },
      OR: [{ validUntil: null }, { validUntil: { gt: now } }],
      role: { deletedAt: null, ...DIRECTOR_ROLE },
    },
    select: { id: true },
  });
  return found !== null;
}
