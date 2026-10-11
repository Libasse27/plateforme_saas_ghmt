import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

const CODE_LABEL = 'ghmt:auth:mfa-email-code';
const CODE_DIGITS = 6;
const CODE_SPACE = 10 ** CODE_DIGITS;

/** Clé dérivée de `BLIND_INDEX_KEY` (base64) avec le libellé du contrat : jamais la clé maîtresse directement. */
export function deriveEmailCodeKey(blindIndexKey: string): Buffer {
  return createHmac('sha256', Buffer.from(blindIndexKey, 'base64')).update(CODE_LABEL).digest();
}

/** Code à 6 chiffres, zéros initiaux conservés. */
export function generateEmailCode(): string {
  return String(randomInt(CODE_SPACE)).padStart(CODE_DIGITS, '0');
}

/** Empreinte liée à l'utilisateur et à la session : un code d'une autre session ne correspond pas. */
export function hashEmailCode(key: Buffer, userId: string, sessionId: string, code: string): Uint8Array<ArrayBuffer> {
  const digest = createHmac('sha256', key).update(`${userId}:${sessionId}:${code}`).digest();
  const out = new Uint8Array(new ArrayBuffer(digest.length));
  out.set(digest);
  return out;
}

export function emailCodeMatches(stored: Uint8Array, candidate: Uint8Array): boolean {
  return stored.length === candidate.length && timingSafeEqual(stored, candidate);
}
