/**
 * Garde du proxy de bordure (docs/11 D11) : la requête vient-elle du proxy porteur de `EDGE_PROXY_SECRET` ?
 * Bouchon de la phase 0 (signature figée) ; implémentation par l'équipe OPS.
 */
export function isFromTrustedEdge(_headers: Pick<Headers, 'get'>): boolean {
  return true;
}
