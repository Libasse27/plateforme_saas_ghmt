import { describe, expect, it } from 'vitest';
import { buildSecurityHeaders } from './security-headers';

const find = (headers: ReturnType<typeof buildSecurityHeaders>, key: string) => headers.find((h) => h.key === key)?.value;

describe('buildSecurityHeaders', () => {
  it('impose Referrer-Policy: no-referrer', () => {
    expect(find(buildSecurityHeaders('development'), 'Referrer-Policy')).toBe('no-referrer');
  });
  it('active HSTS uniquement en production', () => {
    expect(find(buildSecurityHeaders('production'), 'Strict-Transport-Security')).toBe('max-age=63072000; includeSubDomains');
    expect(find(buildSecurityHeaders('development'), 'Strict-Transport-Security')).toBeUndefined();
    expect(find(buildSecurityHeaders(undefined), 'Strict-Transport-Security')).toBeUndefined();
  });
  it('conserve les en-têtes de durcissement existants', () => {
    const headers = buildSecurityHeaders('production');
    expect(find(headers, 'X-Frame-Options')).toBe('DENY');
    expect(find(headers, 'X-Content-Type-Options')).toBe('nosniff');
    expect(find(headers, 'Permissions-Policy')).toContain('camera=()');
  });
});
