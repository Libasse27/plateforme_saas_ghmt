import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FieldCrypto } from '../../../common/crypto/field-crypto.service';
import type { Env } from '../../../infrastructure/config/env';
import { FileEnvelope, fileKeyContext } from './file-envelope';

const crypto = new FieldCrypto({
  DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  BLIND_INDEX_KEY: randomBytes(32).toString('base64'),
} as Env);
const envelope = new FileEnvelope(crypto);
const TENANT_A = '0192f0a0-0000-7000-8000-00000000000a';
const TENANT_B = '0192f0a0-0000-7000-8000-00000000000b';
const MARKER = Buffer.from('CARTE-IDENTITE-NDIAYE-FATOU');

describe('FileEnvelope (chiffrement d’enveloppe, docs/13 D4)', () => {
  it('chiffre puis déchiffre un contenu (aller-retour en mémoire)', () => {
    const fileId = randomUUID();
    const content = Buffer.concat([MARKER, randomBytes(100_000)]);

    const sealed = envelope.seal(TENANT_A, fileId, content);

    expect(envelope.open(TENANT_A, fileId, sealed.wrappedKey, sealed.object).equals(content)).toBe(true);
  });

  it('rend l’objet stocké illisible : aucun octet du contenu en clair, taille = contenu + en-tête', () => {
    const sealed = envelope.seal(TENANT_A, randomUUID(), MARKER);

    expect(sealed.object.includes(MARKER)).toBe(false);
    expect(sealed.object.length).toBe(MARKER.length + 29);
  });

  it('tire une clé de données aléatoire par fichier, enveloppée par FieldCrypto avec l’AAD du fichier', () => {
    const fileId = randomUUID();
    const first = envelope.seal(TENANT_A, fileId, MARKER);
    const second = envelope.seal(TENANT_A, fileId, MARKER);

    const firstKey = crypto.decrypt(fileKeyContext(TENANT_A, fileId), first.wrappedKey);
    const secondKey = crypto.decrypt(fileKeyContext(TENANT_A, fileId), second.wrappedKey);

    expect(Buffer.from(firstKey, 'base64')).toHaveLength(32);
    expect(firstKey).not.toBe(secondKey);
    expect(first.object.equals(second.object)).toBe(false);
    expect(fileKeyContext(TENANT_A, fileId)).toBe(`${TENANT_A}:files:${fileId}`);
  });

  it('refuse de déchiffrer sans la bonne clé enveloppée (clé d’un autre fichier)', () => {
    const fileId = randomUUID();
    const sealed = envelope.seal(TENANT_A, fileId, MARKER);
    const other = envelope.seal(TENANT_A, fileId, MARKER);

    expect(() => envelope.open(TENANT_A, fileId, other.wrappedKey, sealed.object)).toThrow();
  });

  it('lie la clé et l’objet au tenant et au fichier (AAD) : un autre tenant ou un autre fichier ne déchiffre pas', () => {
    const fileId = randomUUID();
    const sealed = envelope.seal(TENANT_A, fileId, MARKER);

    expect(() => envelope.open(TENANT_B, fileId, sealed.wrappedKey, sealed.object)).toThrow();
    expect(() => envelope.open(TENANT_A, randomUUID(), sealed.wrappedKey, sealed.object)).toThrow();
  });

  it('détecte une altération de l’objet (tag GCM) : aucun octet n’est restitué', () => {
    const fileId = randomUUID();
    const sealed = envelope.seal(TENANT_A, fileId, randomBytes(4096));
    const tampered = Buffer.from(sealed.object);
    tampered[tampered.length - 1] ^= 0xff;
    const header = Buffer.from(sealed.object);
    header[20] ^= 0xff;

    expect(() => envelope.open(TENANT_A, fileId, sealed.wrappedKey, tampered)).toThrow();
    expect(() => envelope.open(TENANT_A, fileId, sealed.wrappedKey, header)).toThrow();
  });

  it('refuse un objet tronqué ou de format inconnu', () => {
    const fileId = randomUUID();
    const sealed = envelope.seal(TENANT_A, fileId, MARKER);
    const unknownVersion = Buffer.from(sealed.object);
    unknownVersion[0] = 9;

    expect(() => envelope.open(TENANT_A, fileId, sealed.wrappedKey, sealed.object.subarray(0, 10))).toThrow(/Format/);
    expect(() => envelope.open(TENANT_A, fileId, sealed.wrappedKey, unknownVersion)).toThrow(/Format/);
  });
});
