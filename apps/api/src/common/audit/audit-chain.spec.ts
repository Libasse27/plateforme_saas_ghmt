import { describe, expect, it } from 'vitest';
import { GENESIS_HASH, canonicalJson, chainHash, verifyChain, type ChainedRecord } from './audit-chain';

function buildChain(payloads: readonly unknown[]): ChainedRecord[] {
  return payloads.reduce<ChainedRecord[]>((chain, payload, i) => {
    const prevHash = i === 0 ? GENESIS_HASH : Buffer.from(chain[i - 1]!.hash);
    return [...chain, { chainSeq: BigInt(i + 1), prevHash, hash: chainHash(prevHash, payload), payload }];
  }, []);
}

describe('chaîne d’audit', () => {
  it('produit un JSON canonique indépendant de l’ordre des clés', () => {
    expect(canonicalJson({ b: 1, a: { d: 2n, c: [1, 'x'] } })).toBe(canonicalJson({ a: { c: [1, 'x'], d: 2n }, b: 1 }));
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('valide une chaîne intacte', () => {
    expect(verifyChain(buildChain([{ action: 'a' }, { action: 'b' }, { action: 'c' }]))).toBe(true);
  });

  it('détecte la modification d’un événement', () => {
    const chain = buildChain([{ action: 'a' }, { action: 'b' }]);
    const tampered = chain.map((r, i) => (i === 1 ? { ...r, payload: { action: 'falsifié' } } : r));
    expect(verifyChain(tampered)).toBe(false);
  });

  it('détecte la suppression d’un maillon', () => {
    const chain = buildChain([{ action: 'a' }, { action: 'b' }, { action: 'c' }]);
    expect(verifyChain([chain[0]!, chain[2]!])).toBe(false);
  });
});
