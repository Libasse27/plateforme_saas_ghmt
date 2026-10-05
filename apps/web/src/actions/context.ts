import { parseMe, type Me } from '@/lib/auth/me';
import { isUuid } from '@/lib/domain/raw';
import { actionApi } from '@/server/api';

/** Profil courant relu côté serveur pour décider (pays, fuseau, droits) sans jamais croire le navigateur. */
export async function currentMe(): Promise<Me> {
  return parseMe((await actionApi('/auth/me')).data);
}

export const INVALID_REQUEST = { ok: false, message: 'Demande invalide. Actualisez la page puis réessayez.' } as const;

/** Identifiant de chemin : refuse tout ce qui n'est pas un UUID (anti-injection de chemin vers l'API). */
export function pathId(value: string | undefined): string | null {
  return isUuid(value) ? value : null;
}

/** Devise d'affichage fournie par le formulaire (information d'affichage uniquement). */
export function currencyOf(value: string | undefined): string {
  return /^[A-Z]{3}$/.test(value ?? '') ? (value as string) : 'XOF';
}
