import { describe, expect, it } from 'vitest';
import { DomainError } from '../../../common/errors/domain-error';
import { parseTrustedCidr } from './trusted-cidr';

const codeOf = (cidr: string): string | null => {
  try {
    parseTrustedCidr(cidr);
    return null;
  } catch (error: unknown) {
    return error instanceof DomainError ? `${error.status} ${error.code}` : 'autre';
  }
};

describe('parseTrustedCidr (docs/11 §14.1)', () => {
  it('accepte une plage publique de /24 au moins (IPv4) ou /48 (IPv6), normalisée', () => {
    expect(parseTrustedCidr('41.82.10.77/24')).toMatchObject({ family: 4, prefix: 24, network: '41.82.10.0/24' });
    expect(parseTrustedCidr('154.124.5.7/32').network).toBe('154.124.5.7/32');
    expect(parseTrustedCidr('2c0f:f248:1::/48')).toMatchObject({ family: 6, prefix: 48 });
    expect(parseTrustedCidr('::ffff:41.82.10.0/120').network).toBe('41.82.10.0/24');
  });

  it.each(['pas-une-plage', '41.82.10.9', '300.1.1.0/24', '41.82.10.0/33'])('refuse une valeur mal formée : %s (422 invalid_cidr)', (cidr) => {
    expect(codeOf(cidr)).toBe('422 invalid_cidr');
  });

  it.each(['41.82.0.0/16', '41.82.10.0/23', '0.0.0.0/0', '2c0f:f248::/32', '2c0f:f248::/47', '::ffff:0:0/96'])('refuse une plage trop large : %s (422 cidr_too_broad)', (cidr) => {
    expect(codeOf(cidr)).toBe('422 cidr_too_broad');
  });

  it.each([
    '10.1.2.0/24',
    '172.16.5.0/24',
    '192.168.1.0/24',
    '100.64.3.0/24',
    '127.0.0.0/24',
    '169.254.1.0/24',
    '0.0.0.0/24',
    '224.0.0.0/24',
    '192.0.2.0/24',
    '198.51.100.0/24',
    '203.0.113.0/24',
    '::1/128',
    'fc00:1:2::/48',
    'fd12:3456:789a::/48',
    'fe80::/64',
    '2001:db8:1::/48',
    '::ffff:10.0.0.0/120',
  ])('refuse une plage privée, spéciale ou de documentation : %s (422 cidr_reserved)', (cidr) => {
    expect(codeOf(cidr)).toBe('422 cidr_reserved');
  });
});
