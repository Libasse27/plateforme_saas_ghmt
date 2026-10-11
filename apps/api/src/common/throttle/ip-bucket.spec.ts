import { describe, expect, it } from 'vitest';
import { ipRateLimitKey } from './ip-bucket';

describe('ipRateLimitKey (seau du limiteur par IP)', () => {
  it('laisse une IPv4 inchangée', () => {
    expect(ipRateLimitKey('203.0.113.7')).toBe('203.0.113.7');
  });

  it('ramène une IPv4 encapsulée (::ffff:a.b.c.d, toutes formes) à l’IPv4', () => {
    expect(ipRateLimitKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(ipRateLimitKey('::FFFF:203.0.113.7')).toBe('203.0.113.7');
    expect(ipRateLimitKey('::ffff:cb00:7107')).toBe('203.0.113.7');
    expect(ipRateLimitKey('0:0:0:0:0:ffff:cb00:7107')).toBe('203.0.113.7');
  });

  it('regroupe une IPv6 par /64 : un client qui fait varier son identifiant d’interface reste dans le même seau', () => {
    const bucket = ipRateLimitKey('2001:db8:abcd:12::1');

    expect(bucket).toBe('2001:db8:abcd:12::/64');
    expect(ipRateLimitKey('2001:0db8:ABCD:0012:ffff:ffff:ffff:fffe')).toBe(bucket);
    expect(ipRateLimitKey('2001:db8:abcd:12:1234:5678:9abc:def0')).toBe(bucket);
  });

  it('sépare deux /64 voisins', () => {
    expect(ipRateLimitKey('2001:db8:abcd:13::1')).not.toBe(ipRateLimitKey('2001:db8:abcd:12::1'));
  });

  it('gère les formes compressées en tête, l’identifiant de zone et la notation à IPv4 finale', () => {
    expect(ipRateLimitKey('::1')).toBe('0:0:0:0::/64');
    expect(ipRateLimitKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(ipRateLimitKey('2001:db8:1:2:3:4:192.0.2.1')).toBe('2001:db8:1:2::/64');
    expect(ipRateLimitKey('2001:db8::')).toBe('2001:db8:0:0::/64');
  });

  it('rend telle quelle une valeur qui n’est pas une IP, et `unknown` sans valeur', () => {
    expect(ipRateLimitKey('pas-une-ip')).toBe('pas-une-ip');
    expect(ipRateLimitKey(undefined)).toBe('unknown');
    expect(ipRateLimitKey('')).toBe('unknown');
  });
});
