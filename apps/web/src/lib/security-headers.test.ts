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
  it('ajoute l\'isolation d\'origine (COOP, CORP, Origin-Agent-Cluster) et coupe le préchargement DNS', () => {
    const headers = buildSecurityHeaders('production');
    expect(find(headers, 'Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(find(headers, 'Cross-Origin-Resource-Policy')).toBe('same-origin');
    expect(find(headers, 'Origin-Agent-Cluster')).toBe('?1');
    expect(find(headers, 'X-DNS-Prefetch-Control')).toBe('off');
  });
  it('étend Permissions-Policy aux capteurs, paiement, USB et topics', () => {
    expect(find(buildSecurityHeaders('development'), 'Permissions-Policy')).toBe(
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
    );
  });
  it('ne pose pas la CSP ici : elle dépend d\'un nonce par requête (proxy.ts)', () => {
    expect(find(buildSecurityHeaders('production'), 'Content-Security-Policy')).toBeUndefined();
  });
});
