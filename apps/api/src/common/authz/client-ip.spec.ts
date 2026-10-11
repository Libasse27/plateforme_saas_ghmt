import { describe, expect, it } from 'vitest';
import { normalizeClientIp } from './client-ip';

describe('normalizeClientIp', () => {
  it('conserve une IPv4 ou une IPv6 publique valide', () => {
    expect(normalizeClientIp('41.82.10.7')).toBe('41.82.10.7');
    expect(normalizeClientIp('2c0f:f248::1')).toBe('2c0f:f248::1');
  });

  it('ramène une IPv4 encapsulée ::ffff:a.b.c.d à son IPv4', () => {
    expect(normalizeClientIp('::ffff:41.82.10.7')).toBe('41.82.10.7');
    expect(normalizeClientIp('::FFFF:41.82.10.7')).toBe('41.82.10.7');
  });

  it('ramène aussi une IPv4 encapsulée en forme hexadécimale (::ffff:2952:a07) à son IPv4', () => {
    expect(normalizeClientIp('::ffff:2952:a07')).toBe('41.82.10.7');
    expect(normalizeClientIp('::FFFF:2952:A07')).toBe('41.82.10.7');
    expect(normalizeClientIp('::ffff:a00:1')).toBeNull();
  });

  it('traite les plages de transition IPv6 (NAT64, 6to4, Teredo, rejet) comme absentes', () => {
    for (const value of ['64:ff9b::2952:a07', '2002:2952:a07::1', '2001:0:4136:e378::1', '100::1', '::2952:a07']) expect(normalizeClientIp(value), value).toBeNull();
  });

  it('renvoie null pour une IP absente ou invalide (hors réseau de confiance)', () => {
    for (const value of [undefined, null, '', 'abc', '999.1.1.1', 'fe80::1%eth0', '41.82.10.7/24', ' 41.82.10.7']) {
      expect(normalizeClientIp(value as string | undefined), String(value)).toBeNull();
    }
  });

  it('traite une IP privée ou spéciale comme absente (décision 23)', () => {
    const special = [
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.10',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.1.1',
      '0.0.0.0',
      '224.0.0.1',
      '192.0.2.7',
      '198.51.100.7',
      '203.0.113.7',
      '::1',
      'fd00::1',
      'fe80::1',
      '2001:db8::1',
      '::ffff:10.0.0.1',
      '::ffff:127.0.0.1',
    ];
    for (const value of special) expect(normalizeClientIp(value), value).toBeNull();
  });
});
