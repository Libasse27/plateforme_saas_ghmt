import { createHash } from 'node:crypto';

export const GENESIS_HASH = Buffer.alloc(32);

/** JSON canonique (clés triées, récursif) : le hachage ne dépend pas de l'ordre d'insertion. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function chainHash(prevHash: Uint8Array, payload: unknown): Buffer {
  return createHash('sha256').update(prevHash).update(canonicalJson(payload)).digest();
}

export interface ChainedRecord {
  readonly chainSeq: bigint;
  readonly prevHash: Uint8Array;
  readonly hash: Uint8Array;
  readonly payload: unknown;
}

/** Vérifie une portion de chaîne triée par chainSeq : continuité, liens et empreintes. */
export function verifyChain(records: readonly ChainedRecord[]): boolean {
  return records.every((record, i) => {
    const expected = chainHash(record.prevHash, record.payload);
    if (!expected.equals(Buffer.from(record.hash))) return false;
    if (i === 0) return true;
    const previous = records[i - 1]!;
    return record.chainSeq === previous.chainSeq + 1n && Buffer.from(record.prevHash).equals(Buffer.from(previous.hash));
  });
}
