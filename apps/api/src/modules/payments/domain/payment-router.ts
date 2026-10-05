/** Ordre par défaut : l'agrégateur réel d'abord, le simulateur en repli (s'il est actif). */
export const DEFAULT_PROVIDER_ORDER: readonly string[] = ['cinetpay', 'sandbox'];

/**
 * Fournisseurs candidats, par ordre de préférence, pour un pays et une devise.
 * Clés de routage : `PAYS:DEVISE`, puis `DEVISE`, puis `*`. Les fournisseurs inactifs sont écartés par l'appelant.
 */
export function resolveProviderOrder(routes: Readonly<Record<string, readonly string[]>>, countryCode: string, currency: string): string[] {
  const configured = routes[`${countryCode}:${currency}`] ?? routes[currency] ?? routes['*'] ?? DEFAULT_PROVIDER_ORDER;
  return [...new Set(configured)];
}
