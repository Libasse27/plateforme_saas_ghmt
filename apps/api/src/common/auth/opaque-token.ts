import { createHash, randomBytes } from 'node:crypto';
import type { Bytes } from '../crypto/field-crypto.service';
import { isUuid } from '../pipes/uuid.pipe';

const SECRET_BYTES = 32; // 256 bits
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/; // 32 octets en base64url

export interface IssuedOpaqueToken {
  /** Valeur remise au client, `<tenantId>.<secret>`. */
  readonly token: string;
  /** Seule empreinte stockée en base. */
  readonly hash: Bytes;
}

export interface ParsedOpaqueToken {
  readonly tenantId: string;
  readonly hash: Bytes;
}

function sha256(value: string): Bytes {
  const digest = createHash('sha256').update(value).digest();
  const out = new Uint8Array(new ArrayBuffer(digest.length));
  out.set(digest);
  return out;
}

/**
 * Jeton opaque de 256 bits préfixé par le tenant : le préfixe sert uniquement à choisir le contexte RLS,
 * le serveur ne fait confiance qu'au hash du secret retrouvé DANS ce tenant.
 */
export function issueOpaqueToken(tenantId: string): IssuedOpaqueToken {
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  return { token: `${tenantId}.${secret}`, hash: sha256(secret) };
}

export function parseOpaqueToken(raw: string): ParsedOpaqueToken | undefined {
  const separator = raw.indexOf('.');
  if (separator < 0) return undefined;
  const tenantId = raw.slice(0, separator);
  const secret = raw.slice(separator + 1);
  if (!isUuid(tenantId) || !SECRET_PATTERN.test(secret)) return undefined;
  return { tenantId: tenantId.toLowerCase(), hash: sha256(secret) };
}
