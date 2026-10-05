import { describe, expect, it } from 'vitest';
import { GENESIS_HASH, chainHash } from '../../../common/audit/audit-chain';
import { auditPayload } from '../../../common/audit/audit.service';
import { findFirstBrokenSeq, type AuditChainRow } from './chain-verification';

const TENANT = '018f0000-0000-7000-8000-0000000000aa';

/** Chaîne valide en mémoire de `count` maillons à partir de `startSeq`. */
function buildChain(count: number, startSeq = 1n): AuditChainRow[] {
  const rows: AuditChainRow[] = [];
  let prev: Uint8Array = startSeq === 1n ? GENESIS_HASH : Buffer.alloc(32, 7);
  for (let i = 0; i < count; i += 1) {
    const base = {
      tenantId: TENANT,
      chainSeq: startSeq + BigInt(i),
      occurredAt: new Date(Date.UTC(2026, 9, 5, 10, 0, i)),
      actorType: 'user',
      actorUserId: null,
      sessionId: null,
      ip: '10.0.0.1',
      action: 'x.y',
      resourceType: null,
      resourceId: null,
      patientId: null,
      outcome: 'success',
      changes: { i },
      requestId: null,
    };
    const hash = chainHash(prev, auditPayload(base));
    rows.push({ ...base, prevHash: prev, hash });
    prev = hash;
  }
  return rows;
}

describe('findFirstBrokenSeq', () => {
  it('renvoie null pour une chaîne intacte commençant à la genèse', () => {
    expect(findFirstBrokenSeq(buildChain(5))).toBeNull();
  });

  it('renvoie null pour une fenêtre intacte ne commençant pas à 1 (ancre = prev_hash du premier maillon)', () => {
    expect(findFirstBrokenSeq(buildChain(4, 100n))).toBeNull();
  });

  it('renvoie null pour une liste vide ou un seul maillon valide', () => {
    expect(findFirstBrokenSeq([])).toBeNull();
    expect(findFirstBrokenSeq(buildChain(1))).toBeNull();
  });

  it('détecte un contenu altéré : le maillon dont l’empreinte ne correspond plus', () => {
    const chain = buildChain(6);
    const tampered = chain.map((row, i) => (i === 3 ? { ...row, action: 'effacé' } : row));

    expect(findFirstBrokenSeq(tampered)).toBe(4n);
  });

  it('détecte une empreinte remplacée', () => {
    const chain = buildChain(4);
    const tampered = chain.map((row, i) => (i === 2 ? { ...row, hash: Buffer.alloc(32, 1) } : row));

    expect(findFirstBrokenSeq(tampered)).toBe(3n);
  });

  it('détecte un lien rompu (prev_hash ne pointant pas sur le maillon précédent) et l’attribue au maillon suivant', () => {
    const chain = buildChain(5);
    const prev = chain[2]!;
    const forged = { ...chain[3]!, prevHash: Buffer.alloc(32, 9) };
    forged.hash = chainHash(forged.prevHash, auditPayload(forged));
    const tampered = [chain[0]!, chain[1]!, prev, forged, chain[4]!];

    expect(findFirstBrokenSeq(tampered)).toBe(4n);
  });

  it('détecte un maillon supprimé (trou dans la numérotation)', () => {
    const chain = buildChain(5);
    const tampered = [chain[0]!, chain[1]!, chain[3]!, chain[4]!];

    expect(findFirstBrokenSeq(tampered)).toBe(4n);
  });

  it('renvoie le plus petit numéro rompu quand plusieurs maillons sont altérés', () => {
    const chain = buildChain(8);
    const tampered = chain.map((row, i) => (i === 2 || i === 6 ? { ...row, outcome: 'failure' } : row));

    expect(findFirstBrokenSeq(tampered)).toBe(3n);
  });

  it('refuse une chaîne commençant à 1 dont le premier prev_hash n’est pas la genèse', () => {
    const chain = buildChain(3);
    const first = { ...chain[0]!, prevHash: Buffer.alloc(32, 5) };
    first.hash = chainHash(first.prevHash, auditPayload(first));

    expect(findFirstBrokenSeq([first, chain[1]!, chain[2]!])).toBe(1n);
  });
});
