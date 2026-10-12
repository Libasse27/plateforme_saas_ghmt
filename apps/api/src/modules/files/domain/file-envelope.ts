import { createCipheriv, createDecipheriv, randomBytes, type DecipherGCM } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { FieldCrypto, type Bytes } from '../../../common/crypto/field-crypto.service';

const FORMAT_VERSION = 1;
const DATA_KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** En-tête de l'objet stocké : [version 1 o][IV 12 o][tag 16 o], suivi du chiffré. */
export const OBJECT_HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;

export interface SealedFile {
  /** Objet à écrire dans le stockage : chiffré, jamais de contenu en clair. */
  readonly object: Buffer;
  /** Clé de données chiffrée par FieldCrypto (colonne `tenant.files.wrapped_key`). */
  readonly wrappedKey: Bytes;
}

/**
 * Contexte (AAD) d'un fichier : `<tenantId>:files:<fileId>`. Il lie la clé enveloppée ET l'objet au tenant et au fichier :
 * une clé ou un objet copié vers un autre tenant ou un autre fichier ne se déchiffre pas.
 */
export function fileKeyContext(tenantId: string, fileId: string): string {
  return `${tenantId}:files:${fileId}`;
}

function formatError(): Error {
  return new Error('Format d’objet chiffré non reconnu');
}

/** Lit l'en-tête : IV et tag d'authentification (le tag est connu à l'écriture, le contenu étant entièrement en mémoire). */
function parseHeader(header: Buffer): { iv: Buffer; tag: Buffer } {
  if (header.length < OBJECT_HEADER_BYTES || header[0] !== FORMAT_VERSION) throw formatError();
  return { iv: header.subarray(1, 1 + IV_BYTES), tag: header.subarray(1 + IV_BYTES, OBJECT_HEADER_BYTES) };
}

/**
 * Chiffrement d'enveloppe des documents (docs/13 D4) : une clé de données AES-256-GCM aléatoire par fichier, enveloppée
 * par FieldCrypto. En P14, seul l'enveloppement passe au KMS, sans réécrire les objets.
 */
@Injectable()
export class FileEnvelope {
  constructor(private readonly crypto: FieldCrypto) {}

  seal(tenantId: string, fileId: string, plaintext: Buffer): SealedFile {
    const context = fileKeyContext(tenantId, fileId);
    const dataKey = randomBytes(DATA_KEY_BYTES);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const object = Buffer.concat([Buffer.from([FORMAT_VERSION]), iv, cipher.getAuthTag(), ciphertext]);
    const wrappedKey = this.crypto.encrypt(context, dataKey.toString('base64'));
    dataKey.fill(0);
    return { object, wrappedKey };
  }

  /**
   * Déchiffrement en mémoire (analyse antivirus, téléchargement) : le tag GCM est vérifié sur tout l'objet AVANT de rendre
   * le moindre octet. Lève si la clé, le contexte ou l'objet ne concordent pas (objet altéré, tronqué, d'un autre fichier).
   */
  open(tenantId: string, fileId: string, wrappedKey: Uint8Array, object: Buffer): Buffer {
    const { iv, tag } = parseHeader(object);
    const decipher = this.decipher(tenantId, fileId, wrappedKey, iv, tag);
    return Buffer.concat([decipher.update(object.subarray(OBJECT_HEADER_BYTES)), decipher.final()]);
  }

  private decipher(tenantId: string, fileId: string, wrappedKey: Uint8Array, iv: Buffer, tag: Buffer): DecipherGCM {
    const context = fileKeyContext(tenantId, fileId);
    const dataKey = Buffer.from(this.crypto.decrypt(context, wrappedKey), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', dataKey, iv);
    dataKey.fill(0);
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(tag);
    return decipher;
  }
}
