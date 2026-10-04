import { createHash, randomBytes } from 'node:crypto';

const PREFIX = 'p.';
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface IssuedPlatformToken {
  /** Valeur remise au client : `p.<secret 256 bits>`. Le préfixe distingue ces jetons de ceux des tenants (`<uuid>.<secret>`). */
  readonly token: string;
  /** Seule empreinte stockée en base. */
  readonly hash: Uint8Array<ArrayBuffer>;
}

function sha256(value: string): Uint8Array<ArrayBuffer> {
  const digest = createHash('sha256').update(value).digest();
  const out = new Uint8Array(new ArrayBuffer(digest.length));
  out.set(digest);
  return out;
}

export function issuePlatformToken(): IssuedPlatformToken {
  const secret = randomBytes(32).toString('base64url');
  return { token: `${PREFIX}${secret}`, hash: sha256(secret) };
}

/** Empreinte d'un jeton reçu, ou `undefined` s'il n'a pas le format plateforme (un jeton tenant est rejeté ici). */
export function hashPlatformToken(raw: string): Uint8Array<ArrayBuffer> | undefined {
  if (!raw.startsWith(PREFIX)) return undefined;
  const secret = raw.slice(PREFIX.length);
  return SECRET_PATTERN.test(secret) ? sha256(secret) : undefined;
}
