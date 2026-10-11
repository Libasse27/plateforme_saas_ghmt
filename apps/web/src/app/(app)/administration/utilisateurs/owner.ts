import { settle } from '@/lib/api/settle';
import { hasPermission, type Me } from '@/lib/auth/me';
import { toSecurityPolicy } from '@/lib/domain/security';
import { pageApi } from '@/server/api';

/**
 * Identifiant de l'administrateur principal (docs/11 D9), relu dans la politique de sécurité quand le lecteur
 * a `iam:policy:read`. Toute indisponibilité donne null : le badge est une aide, jamais un blocage.
 */
export async function loadOwnerId(me: Pick<Me, 'permissions'>): Promise<string | null> {
  if (!hasPermission(me, 'iam:policy:read')) return null;
  const result = await settle(() => pageApi('/iam/security/policy'));
  return result.ok ? (toSecurityPolicy(result.value.data).owner?.id ?? null) : null;
}
