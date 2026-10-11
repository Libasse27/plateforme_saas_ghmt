import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { LAST_SEEN_REFRESH_MS } from '../auth.constants';

/**
 * Dernière activité (docs/11 D15) : écrite à la connexion et au rafraîchissement, seulement si l'ancienne valeur a plus
 * de 5 minutes. Aucune écriture par requête ; la granularité réelle est la durée du jeton d'accès. Retourne vrai si écrite.
 */
export async function touchLastSeen(tx: TenantTx, tenantId: string, userId: string, now: Date): Promise<boolean> {
  const threshold = new Date(now.getTime() - LAST_SEEN_REFRESH_MS);
  const { count } = await tx.user.updateMany({
    where: { tenantId, id: userId, OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: threshold } }] },
    data: { lastSeenAt: now },
  });
  return count > 0;
}
