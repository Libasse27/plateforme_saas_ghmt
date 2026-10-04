import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { issueOpaqueToken, parseOpaqueToken } from './opaque-token';

describe('opaque-token', () => {
  it('émet un jeton <tenantId>.<secret> de 256 bits dont seul le hash SHA-256 est retourné', () => {
    const tenantId = randomUUID();

    const { token, hash } = issueOpaqueToken(tenantId);

    const [prefix, secret] = token.split('.');
    expect(prefix).toBe(tenantId);
    expect(Buffer.from(secret!, 'base64url')).toHaveLength(32);
    expect(Buffer.from(hash).equals(createHash('sha256').update(secret!).digest())).toBe(true);
  });

  it('émet des jetons distincts à chaque appel', () => {
    const tenantId = randomUUID();
    expect(issueOpaqueToken(tenantId).token).not.toBe(issueOpaqueToken(tenantId).token);
  });

  it('retrouve le tenant et le hash à partir du jeton brut', () => {
    const tenantId = randomUUID();
    const { token, hash } = issueOpaqueToken(tenantId);

    const parsed = parseOpaqueToken(token);

    expect(parsed?.tenantId).toBe(tenantId);
    expect(Buffer.from(parsed!.hash).equals(Buffer.from(hash))).toBe(true);
  });

  it.each([
    ['chaîne vide', ''],
    ['sans séparateur', 'abcdefghijklmnopqrstuvwxyz0123456789abcdefghij'],
    ['tenant non UUID', `pas-un-uuid.${'a'.repeat(43)}`],
    ['secret trop court', `${randomUUID()}.abc`],
    ['secret avec caractères interdits', `${randomUUID()}.${'é'.repeat(43)}`],
  ])('rejette un jeton mal formé (%s)', (_label, raw) => {
    expect(parseOpaqueToken(raw)).toBeUndefined();
  });
});
