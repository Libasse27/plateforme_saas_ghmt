import { describe, expect, it } from 'vitest';
import { deriveEmailCodeKey, emailCodeMatches, generateEmailCode, hashEmailCode } from './mfa-email-code';

const KEY = Buffer.alloc(32, 7).toString('base64');

describe('code e-mail d’enrôlement MFA', () => {
  it('génère toujours 6 chiffres', () => {
    for (let i = 0; i < 200; i += 1) expect(generateEmailCode()).toMatch(/^\d{6}$/);
  });

  it('dérive une clé distincte de la clé maîtresse et stable', () => {
    const derived = deriveEmailCodeKey(KEY);
    expect(derived.equals(Buffer.from(KEY, 'base64'))).toBe(false);
    expect(derived.equals(deriveEmailCodeKey(KEY))).toBe(true);
  });

  it('lie l’empreinte à l’utilisateur, à la session et au code', () => {
    const key = deriveEmailCodeKey(KEY);
    const base = hashEmailCode(key, 'u1', 's1', '012345');
    expect(emailCodeMatches(base, hashEmailCode(key, 'u1', 's1', '012345'))).toBe(true);
    expect(emailCodeMatches(base, hashEmailCode(key, 'u1', 's2', '012345'))).toBe(false);
    expect(emailCodeMatches(base, hashEmailCode(key, 'u2', 's1', '012345'))).toBe(false);
    expect(emailCodeMatches(base, hashEmailCode(key, 'u1', 's1', '012346'))).toBe(false);
    expect(emailCodeMatches(base, new Uint8Array(3))).toBe(false);
  });
});
