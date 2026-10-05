import { DomainError } from '../../../common/errors/domain-error';
import { decodeCursor, encodeCursor } from '../../../common/pagination/page';

const SEQ_PATTERN = /^\d{1,19}$/;
const MAX_BIGINT_64 = 9223372036854775807n;
const INVALID_CURSOR = [{ path: 'cursor', code: 'invalid_cursor', message: 'Curseur invalide.' }] as const;

export function encodeSeqCursor(seq: bigint): string {
  return encodeCursor(seq.toString());
}

/** Curseur du journal : `chain_seq` décimal encodé ; toute autre forme ⇒ 422 (jamais interprétée par la requête). */
export function decodeSeqCursor(cursor: string | undefined): bigint | undefined {
  const decoded = decodeCursor(cursor);
  if (decoded === undefined) return undefined;
  if (!SEQ_PATTERN.test(decoded)) throw DomainError.validation(INVALID_CURSOR);
  const seq = BigInt(decoded);
  if (seq > MAX_BIGINT_64) throw DomainError.validation(INVALID_CURSOR);
  return seq;
}
