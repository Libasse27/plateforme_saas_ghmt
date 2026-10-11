import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';

/**
 * Consomme les jetons de réinitialisation encore ouverts d'un utilisateur (changement de mot de passe, désactivation…),
 * dans la transaction de l'appelant. Retourne le nombre de jetons invalidés.
 */
export async function invalidatePasswordResetTokens(tx: TenantTx, tenantId: string, userId: string, now: Date): Promise<number> {
  const result = await tx.passwordResetToken.updateMany({ where: { tenantId, userId, consumedAt: null }, data: { consumedAt: now } });
  return result.count;
}
