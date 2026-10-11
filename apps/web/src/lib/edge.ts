import { createHash, timingSafeEqual } from 'node:crypto';
import { getEdgeProxySecret } from './config';

/** En-tête injecté par le proxy de bordure, qui écrase toute valeur reçue du client. */
export const EDGE_AUTH_HEADER = 'x-ghmt-edge-auth';

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/**
 * Compare deux secrets en temps constant : les deux valeurs sont d'abord ramenées à une empreinte de longueur
 * fixe, ce qui évite aussi de révéler la longueur du secret attendu.
 */
export function edgeSecretMatches(received: string | null | undefined, expected: string): boolean {
  if (!received) return false;
  return timingSafeEqual(digest(received), digest(expected));
}

/** Secret attendu, ou `null` si la configuration est inutilisable en production (aucun accès accepté). */
function expectedSecret(): string | undefined | null {
  try {
    return getEdgeProxySecret(process.env);
  } catch {
    // Production sans secret valide, ou secret trop court : on ferme l'accès plutôt que de l'ouvrir.
    return null;
  }
}

/**
 * Garde du proxy de bordure (docs/11 D11) : la requête vient-elle du proxy porteur de `EDGE_PROXY_SECRET` ?
 * - aucun secret configuré (développement) : vrai ;
 * - secret configuré : l'en-tête `X-Ghmt-Edge-Auth` doit lui être égal (temps constant) ;
 * - configuration invalide : faux (fermé par défaut).
 * Sans cette garde, un accès direct au BFF permettrait de forger l'IP de l'établissement et de contourner le MFA hors réseau.
 */
export function isFromTrustedEdge(headers: Pick<Headers, 'get'>): boolean {
  const secret = expectedSecret();
  if (secret === null) return false;
  if (secret === undefined) return true;
  return edgeSecretMatches(headers.get(EDGE_AUTH_HEADER), secret);
}
