export interface SecurityHeader {
  readonly key: string;
  readonly value: string;
}

const HSTS_MAX_AGE_SECONDS = 63_072_000;

/** En-têtes de durcissement ; HSTS uniquement en production (jamais en HTTP local). */
export function buildSecurityHeaders(nodeEnv: string | undefined): readonly SecurityHeader[] {
  const headers: SecurityHeader[] = [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    // no-referrer : les jetons d'invitation figurent dans l'URL et ne doivent jamais fuiter.
    { key: 'Referrer-Policy', value: 'no-referrer' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  ];
  if (nodeEnv === 'production') {
    headers.push({ key: 'Strict-Transport-Security', value: `max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains` });
  }
  return headers;
}
