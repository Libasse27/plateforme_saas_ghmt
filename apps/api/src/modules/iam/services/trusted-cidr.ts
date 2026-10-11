import { TRUSTED_NETWORK_MIN_PREFIX, isReservedNetwork, parseCidr, type ParsedCidr } from '@ghmt/shared';
import { DomainError } from '../../../common/errors/domain-error';

/**
 * Plage de confiance déclarable (docs/11 §14.1, décision 23) : notation CIDR valide (`invalid_cidr`), au moins /24 en IPv4 et
 * /48 en IPv6 (`cidr_too_broad`), hors plages privées, spéciales et de documentation (`cidr_reserved`).
 */
export function parseTrustedCidr(cidr: string): ParsedCidr {
  const parsed = parseCidr(cidr);
  if (!parsed) throw DomainError.unprocessable('invalid_cidr', 'Plage réseau invalide : utilisez la notation CIDR, par exemple 41.82.10.0/24.');
  const minimum = parsed.family === 4 ? TRUSTED_NETWORK_MIN_PREFIX.v4 : TRUSTED_NETWORK_MIN_PREFIX.v6;
  if (parsed.prefix < minimum) {
    throw DomainError.unprocessable('cidr_too_broad', `Plage trop large : le préfixe minimal est /${minimum} (${parsed.family === 4 ? 'IPv4' : 'IPv6'}).`);
  }
  if (isReservedNetwork(parsed)) {
    throw DomainError.unprocessable('cidr_reserved', 'Plage privée ou réservée : déclarez l’adresse publique de l’établissement.');
  }
  return parsed;
}
