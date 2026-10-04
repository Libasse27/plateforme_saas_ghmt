import { createHash, randomInt } from 'node:crypto';

export const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_LENGTH = 10;
/** A-Z et 2-9 (33 symboles) : le schéma partagé attend `[A-Z2-9]{10}`. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ23456789';

function generateCode(): string {
  return Array.from({ length: BACKUP_CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
}

export function generateBackupCodes(count: number = BACKUP_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) codes.add(generateCode());
  return [...codes];
}

/** Empreinte liée à l'utilisateur ; seule cette valeur est stockée (usage unique à la consommation). */
export function hashBackupCode(userId: string, code: string): string {
  return createHash('sha256').update(`${userId}:${code}`).digest('hex');
}
