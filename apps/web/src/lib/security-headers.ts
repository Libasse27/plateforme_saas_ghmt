export interface SecurityHeader {
  readonly key: string;
  readonly value: string;
}

const HSTS_MAX_AGE_SECONDS = 63_072_000;

/** En-têtes statiques de durcissement (la CSP à nonce est posée par proxy.ts, docs/11 D14) ; HSTS uniquement en production (jamais en HTTP local). */
export function buildSecurityHeaders(nodeEnv: string | undefined): readonly SecurityHeader[] {
  const headers: SecurityHeader[] = [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    // no-referrer : les jetons d'invitation figurent dans l'URL et ne doivent jamais fuiter.
    { key: 'Referrer-Policy', value: 'no-referrer' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()' },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
    { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
    { key: 'Origin-Agent-Cluster', value: '?1' },
    { key: 'X-DNS-Prefetch-Control', value: 'off' },
  ];
  if (nodeEnv === 'production') {
    headers.push({ key: 'Strict-Transport-Security', value: `max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains` });
  }
  return headers;
}
