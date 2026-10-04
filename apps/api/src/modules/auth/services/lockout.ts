import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { LOCKOUT_MINUTES, LOCKOUT_THRESHOLD, MINUTE } from '../auth.constants';

/**
 * Verrouillage progressif : aux paliers de 5 échecs (5, 10, 15, 20…) le compte est verrouillé
 * 1, 5, 15 puis 60 minutes (plafond). Retourne la fin du verrou, ou null hors palier.
 */
export function lockoutAfter(failedAttempts: number, now: Date): Date | null {
  if (failedAttempts < LOCKOUT_THRESHOLD || failedAttempts % LOCKOUT_THRESHOLD !== 0) return null;
  const tier = failedAttempts / LOCKOUT_THRESHOLD - 1;
  const minutes = LOCKOUT_MINUTES[Math.min(tier, LOCKOUT_MINUTES.length - 1)]!;
  return new Date(now.getTime() + minutes * MINUTE);
}

/** Incrément atomique (verrou de ligne) : des tentatives parallèles ne peuvent pas contourner le palier. */
export async function registerFailedAttempt(tx: TenantTx, tenantId: string, userId: string, now: Date): Promise<Date | null> {
  const where = { tenantId_userId: { tenantId, userId } };
  const { failedAttempts } = await tx.userCredential.update({
    where,
    data: { failedAttempts: { increment: 1 } },
    select: { failedAttempts: true },
  });
  const lockedUntil = lockoutAfter(failedAttempts, now);
  if (lockedUntil) await tx.userCredential.update({ where, data: { lockedUntil } });
  return lockedUntil;
}

export async function clearFailedAttempts(tx: TenantTx, tenantId: string, userId: string): Promise<void> {
  await tx.userCredential.update({
    where: { tenantId_userId: { tenantId, userId } },
    data: { failedAttempts: 0, lockedUntil: null },
  });
}
