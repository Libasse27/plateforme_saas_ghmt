/** Un lien est actif sur son chemin exact, ou sur ses sous-chemins (sauf la racine). */
export function isActivePath(href: string, pathname: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}
