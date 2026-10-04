import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../infrastructure/config/env';
import { FieldCrypto } from './field-crypto.service';

const env = {
  DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  BLIND_INDEX_KEY: randomBytes(32).toString('base64'),
} as Env;
const crypto = new FieldCrypto(env);
const TENANT_A = '0192f0a0-0000-7000-8000-00000000000a';
const TENANT_B = '0192f0a0-0000-7000-8000-00000000000b';

describe('FieldCrypto', () => {
  it('chiffre puis déchiffre une valeur', () => {
    const blob = crypto.encrypt(TENANT_A, '+221771234567');
    expect(Buffer.from(blob).toString('utf8')).not.toContain('771234567');
    expect(crypto.decrypt(TENANT_A, blob)).toBe('+221771234567');
  });

  it('produit un chiffré différent à chaque appel (IV aléatoire)', () => {
    expect(Buffer.from(crypto.encrypt(TENANT_A, 'x')).equals(Buffer.from(crypto.encrypt(TENANT_A, 'x')))).toBe(false);
  });

  it('refuse de déchiffrer dans un autre tenant (AAD)', () => {
    const blob = crypto.encrypt(TENANT_A, 'secret');
    expect(() => crypto.decrypt(TENANT_B, blob)).toThrow();
  });

  it('détecte une altération du chiffré', () => {
    const blob = Buffer.from(crypto.encrypt(TENANT_A, 'secret'));
    blob[blob.length - 1] ^= 0xff;
    expect(() => crypto.decrypt(TENANT_A, blob)).toThrow();
  });

  it('calcule un index aveugle normalisé et propre au tenant', () => {
    const a1 = Buffer.from(crypto.blindIndex(TENANT_A, ' AB 12 '));
    const a2 = Buffer.from(crypto.blindIndex(TENANT_A, 'ab12'));
    const b = Buffer.from(crypto.blindIndex(TENANT_B, 'ab12'));
    expect(a1.equals(a2)).toBe(true);
    expect(a1.equals(b)).toBe(false);
  });

  it('gère les valeurs optionnelles', () => {
    expect(crypto.encryptOptional(TENANT_A, undefined)).toBeUndefined();
    expect(crypto.decryptOptional(TENANT_A, null)).toBeUndefined();
  });
});
