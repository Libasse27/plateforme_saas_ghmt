import { isIP } from 'node:net';
import { isReservedNetwork, parseCidr } from '@ghmt/shared';

/**
 * IP cliente utilisable pour décider d'un réseau de confiance (docs/11 D4) : adresse publique valide, ramenée à sa forme
 * IPv4 pour les adresses encapsulées (`::ffff:a.b.c.d` comme `::ffff:a52:a09`), IPv6 compressée en minuscules sinon.
 * Absente, invalide, privée ou spéciale (décision 23) ⇒ `null` (hors réseau de confiance).
 */
export function normalizeClientIp(ip: string | null | undefined): string | null {
  // Un identifiant de zone (`fe80::1%eth0`) n'est pas une adresse PostgreSQL valide : hors réseau de confiance.
  if (!ip || ip.includes('%')) return null;
  const family = isIP(ip);
  if (family === 0) return null;
  const parsed = parseCidr(`${ip}/${family === 4 ? 32 : 128}`);
  // Une plage déclarée ne peut pas couvrir une adresse privée ou spéciale (plages refusées) : on ne s'y fie jamais.
  if (!parsed || isReservedNetwork(parsed)) return null;
  return parsed.network.slice(0, parsed.network.indexOf('/'));
}
