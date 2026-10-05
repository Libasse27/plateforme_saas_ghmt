import { describe, expect, it } from 'vitest';
import { hmacSha256Hex, safeEqualHex } from './webhook-signature';

describe('signature des webhooks', () => {
  it('calcule le HMAC-SHA256 hexadécimal (vecteur RFC 4231, cas 2)', () => {
    expect(hmacSha256Hex('Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  it('compare deux empreintes hexadécimales en temps constant', () => {
    const digest = hmacSha256Hex('secret', 'corps');

    expect(safeEqualHex(digest, digest)).toBe(true);
    expect(safeEqualHex(digest.toUpperCase(), digest)).toBe(true);
    expect(safeEqualHex(hmacSha256Hex('autre', 'corps'), digest)).toBe(false);
  });

  it('refuse sans lever une valeur absente, de longueur différente ou non hexadécimale', () => {
    const digest = hmacSha256Hex('secret', 'corps');

    expect(safeEqualHex(undefined, digest)).toBe(false);
    expect(safeEqualHex('', digest)).toBe(false);
    expect(safeEqualHex(digest.slice(2), digest)).toBe(false);
    expect(safeEqualHex('zz'.repeat(32), digest)).toBe(false);
  });
});
