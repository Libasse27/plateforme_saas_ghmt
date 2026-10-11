import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';

/**
 * Compteur `user_credentials.failed_attempts` : conservé pour l'audit et les alertes, mais sans verrou dur depuis
 * la phase durcissement (docs/11 D3) : le ralentissement vient de `LoginDelayService`. `locked_until` n'est plus écrit.
 */
export async function registerFailedAttempt(tx: TenantTx, tenantId: string, userId: string): Promise<number> {
  const { failedAttempts } = await tx.userCredential.update({
    where: { tenantId_userId: { tenantId, userId } },
    data: { failedAttempts: { increment: 1 } },
    select: { failedAttempts: true },
  });
  return failedAttempts;
}

export async function clearFailedAttempts(tx: TenantTx, tenantId: string, userId: string): Promise<void> {
  await tx.userCredential.update({
    where: { tenantId_userId: { tenantId, userId } },
    data: { failedAttempts: 0 },
  });
}
