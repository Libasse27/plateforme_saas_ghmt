/** Segments de chemin porteurs d'un secret (jeton d'invitation…) : jamais journalisés en clair. */
const SECRET_PATH_SEGMENTS: readonly RegExp[] = [/(\/auth\/invitations\/)[^/?#]+/];

/** URL journalisable : sans query string (termes de recherche) ni jeton dans le chemin. */
export function sanitizeLogUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const path = url.split('?')[0] ?? '';
  return SECRET_PATH_SEGMENTS.reduce((acc, pattern) => acc.replace(pattern, '$1:token'), path);
}
