/** Requête Express vue par la mesure : gabarit de route connu seulement si un contrôleur l'a prise en charge. */
export interface RoutedRequest {
  readonly baseUrl?: string;
  readonly route?: { readonly path?: unknown };
}

/** Label des requêtes sans route (404, refus avant routage) : un chemin inconnu n'entre jamais dans les labels. */
export const UNMATCHED_ROUTE = 'unmatched';

/** Gabarit de route (`/api/v1/patients/:patientId`), jamais l'URL réelle (identifiants, query string). */
export function routeLabel(req: RoutedRequest): string {
  const path = req.route?.path;
  // Un joker (`*path`) est la route « attrape-tout » des 404 de Nest : pas un gabarit métier.
  if (typeof path !== 'string' || path.length === 0 || path.includes('*')) return UNMATCHED_ROUTE;
  return `${req.baseUrl ?? ''}${path}`;
}
