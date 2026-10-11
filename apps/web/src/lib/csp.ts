/**
 * Content-Security-Policy stricte à nonces (docs/11 D14). Module pur : le nonce et la configuration sont fournis
 * par `proxy.ts`, qui pose l'en-tête sur chaque réponse.
 */

export type CspMode = 'enforce' | 'report-only';

export interface CspConfig {
  readonly mode: CspMode;
  readonly reportUri: string | undefined;
  readonly formActionOrigins: readonly string[];
}

export interface CspOptions {
  readonly nonce: string;
  readonly dev: boolean;
  readonly reportUri?: string | undefined;
  readonly formActionOrigins?: readonly string[] | undefined;
}

const NONCE_BYTES = 16;
const NONCE_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const REPORT_GROUP = 'csp-endpoint';
const URL_FORBIDDEN_CHARS = /[\s;,'"]/;

type Env = Readonly<Record<string, string | undefined>>;

/** 128 bits aléatoires, en base64 : un nonce neuf par requête. */
export function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  return btoa(String.fromCharCode(...bytes));
}

function httpsOrigin(value: string): string | null {
  const candidate = value.trim();
  if (candidate === '' || URL_FORBIDDEN_CHARS.test(candidate)) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

function httpsUrl(value: string | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate || URL_FORBIDDEN_CHARS.test(candidate)) return null;
  try {
    return new URL(candidate).protocol === 'https:' ? candidate : null;
  } catch {
    return null;
  }
}

export function buildContentSecurityPolicy({ nonce, dev, reportUri, formActionOrigins = [] }: CspOptions): string {
  if (!NONCE_PATTERN.test(nonce)) throw new Error('Nonce CSP invalide.');
  const origins = [...new Set(formActionOrigins.map(httpsOrigin).filter((origin): origin is string => origin !== null))];
  const report = httpsUrl(reportUri);
  const directives: string[] = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${dev ? ' ws:' : ''}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    `form-action ${["'self'", ...origins].join(' ')}`,
    "manifest-src 'self'",
    "worker-src 'self'",
  ];
  if (!dev) directives.push('upgrade-insecure-requests');
  if (report) directives.push(`report-uri ${report}`, `report-to ${REPORT_GROUP}`);
  return directives.join('; ');
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Lit `CSP_MODE`, `CSP_REPORT_URI` et `CSP_FORM_ACTION_ORIGINS` ; toute valeur inconnue retombe sur `enforce`. */
export function readCspConfig(env: Env = process.env): CspConfig {
  return {
    mode: nonEmpty(env.CSP_MODE) === 'report-only' ? 'report-only' : 'enforce',
    reportUri: nonEmpty(env.CSP_REPORT_URI),
    formActionOrigins: (env.CSP_FORM_ACTION_ORIGINS ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ''),
  };
}

export function cspHeaderName(mode: CspMode): string {
  return mode === 'report-only' ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';
}

/** En-tête `Reporting-Endpoints` qui nomme le groupe cité par `report-to` (absent sans collecteur valide). */
export function reportingEndpointsValue(reportUri: string | undefined): string | null {
  const report = httpsUrl(reportUri);
  return report ? `${REPORT_GROUP}="${report}"` : null;
}
