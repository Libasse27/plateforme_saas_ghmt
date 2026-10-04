import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../../infrastructure/config/env';

const FORMAT_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;

export type Bytes = Uint8Array<ArrayBuffer>;

function toBytes(buf: Buffer): Bytes {
  const out = new Uint8Array(new ArrayBuffer(buf.length));
  out.set(buf);
  return out;
}

/**
 * Chiffrement applicatif des champs sensibles (docs/04 §6) : AES-256-GCM.
 * Format : [version 1 o][IV 12 o][tag 16 o][chiffré]. Le tenant est lié au chiffré via l'AAD :
 * un blob copié dans un autre tenant ne se déchiffre pas.
 * MVP : clé maîtresse unique (env). Cible : DEK par tenant enveloppée par une KEK (KMS/Vault).
 */
@Injectable()
export class FieldCrypto {
  private readonly dataKey: Buffer;
  private readonly indexKey: Buffer;

  constructor(@Inject(ENV) env: Env) {
    this.dataKey = Buffer.from(env.DATA_ENCRYPTION_KEY, 'base64');
    this.indexKey = Buffer.from(env.BLIND_INDEX_KEY, 'base64');
  }

  encrypt(tenantId: string, plaintext: string): Bytes {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.dataKey, iv);
    cipher.setAAD(Buffer.from(tenantId, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return toBytes(Buffer.concat([Buffer.from([FORMAT_VERSION]), iv, cipher.getAuthTag(), ciphertext]));
  }

  decrypt(tenantId: string, blob: Uint8Array): string {
    const buf = Buffer.from(blob);
    if (buf.length < HEADER_BYTES || buf[0] !== FORMAT_VERSION) throw new Error('Format de chiffré non reconnu');
    const iv = buf.subarray(1, 1 + IV_BYTES);
    const tag = buf.subarray(1 + IV_BYTES, HEADER_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', this.dataKey, iv);
    decipher.setAAD(Buffer.from(tenantId, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(buf.subarray(HEADER_BYTES)), decipher.final()]).toString('utf8');
  }

  decryptOptional(tenantId: string, blob: Uint8Array | null | undefined): string | undefined {
    return blob ? this.decrypt(tenantId, blob) : undefined;
  }

  encryptOptional(tenantId: string, plaintext: string | undefined): Bytes | undefined {
    return plaintext === undefined ? undefined : this.encrypt(tenantId, plaintext);
  }

  /**
   * Index aveugle HMAC-SHA-256 pour la recherche exacte sur un champ chiffré.
   * Le tenant fait partie du message : la même valeur donne des index différents d'un tenant à l'autre.
   */
  blindIndex(tenantId: string, value: string): Bytes {
    const normalized = value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, '');
    return toBytes(createHmac('sha256', this.indexKey).update(`${tenantId}\u0000${normalized}`).digest());
  }
}
