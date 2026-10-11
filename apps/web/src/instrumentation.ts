import { getEdgeProxySecret, getTrustedProxyHops } from '@/lib/config';

/**
 * Démarrage du serveur Next : valide la configuration de bordure (docs/11 D11, §6.4).
 * En production, l'absence de TRUSTED_PROXY_HOPS ou d'EDGE_PROXY_SECRET interrompt le démarrage plutôt
 * que de laisser l'IP cliente forgeable. Les valeurs ne sont jamais journalisées.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  getTrustedProxyHops(process.env);
  getEdgeProxySecret(process.env);
}
