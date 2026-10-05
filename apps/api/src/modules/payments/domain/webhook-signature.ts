import { createHmac, timingSafeEqual } from 'node:crypto';

export function hmacSha256Hex(secret: string, payload: string | Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

const HEX_PATTERN = /^[0-9a-f]+$/i;

/** Comparaison d'empreintes hexadécimales en temps constant ; toute anomalie de forme ⇒ false (sans exception). */
export function safeEqualHex(received: string | undefined, expected: string): boolean {
  if (!received || received.length !== expected.length || !HEX_PATTERN.test(received)) return false;
  return timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex'));
}
