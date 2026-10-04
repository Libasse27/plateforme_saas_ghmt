import { describe, expect, it } from 'vitest';
import { BACKUP_CODE_COUNT, generateBackupCodes, hashBackupCode } from './backup-codes';

describe('backup-codes', () => {
  it('génère 10 codes distincts de 10 caractères dans [A-Z2-9]', () => {
    const codes = generateBackupCodes();

    expect(codes).toHaveLength(BACKUP_CODE_COUNT);
    expect(BACKUP_CODE_COUNT).toBe(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[A-Z2-9]{10}$/);
  });

  it('produit des codes différents d’un appel à l’autre', () => {
    expect(generateBackupCodes()).not.toEqual(generateBackupCodes());
  });

  it('hache de façon déterministe, en hexadécimal, sans laisser le code en clair', () => {
    const hash = hashBackupCode('user-1', 'ABCDEFGHJK');

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashBackupCode('user-1', 'ABCDEFGHJK'));
    expect(hash).not.toContain('ABCDEFGHJK');
  });

  it('lie le hash à l’utilisateur (même code, hash différent)', () => {
    expect(hashBackupCode('user-1', 'ABCDEFGHJK')).not.toBe(hashBackupCode('user-2', 'ABCDEFGHJK'));
  });
});
