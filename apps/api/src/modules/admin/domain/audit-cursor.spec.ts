import { describe, expect, it } from 'vitest';
import { DomainError } from '../../../common/errors/domain-error';
import { decodeCursor, encodeCursor } from '../../../common/pagination/page';
import { decodeSeqCursor, encodeSeqCursor } from './audit-cursor';

describe('curseur chain_seq', () => {
  it('décode un curseur absent en undefined', () => {
    expect(decodeSeqCursor(undefined)).toBeUndefined();
    expect(decodeSeqCursor('')).toBeUndefined();
  });

  it('fait l’aller-retour d’un numéro de chaîne, y compris au-delà de 2^53', () => {
    expect(decodeSeqCursor(encodeSeqCursor(42n))).toBe(42n);
    expect(decodeSeqCursor(encodeSeqCursor(9007199254740993n))).toBe(9007199254740993n);
    expect(decodeCursor(encodeSeqCursor(7n))).toBe('7');
  });

  it.each(['abc', '-1', '1.5', '', ' 12', '12 ', '1'.repeat(20), '99999999999999999999', '9223372036854775808', '0x10', '1e3'])(
    'refuse le curseur décodé « %s » avec 422',
    (decoded) => {
      expect(() => decodeSeqCursor(encodeCursor(decoded === '' ? ' ' : decoded))).toThrow(DomainError);
      try {
        decodeSeqCursor(encodeCursor(decoded === '' ? ' ' : decoded));
      } catch (error) {
        expect((error as DomainError).status).toBe(422);
        expect((error as DomainError).extras.errors?.[0]?.path).toBe('cursor');
      }
    },
  );

  it('accepte la valeur maximale d’un bigint signé 64 bits', () => {
    expect(decodeSeqCursor(encodeCursor('9223372036854775807'))).toBe(9223372036854775807n);
  });
});
