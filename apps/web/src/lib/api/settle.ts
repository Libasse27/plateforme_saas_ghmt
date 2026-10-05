import { isApiError } from './errors';
import { describeApiError } from './messages';

export type Settled<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string; readonly status: number };

/**
 * Exécute un chargement de page : une erreur d'API devient un message français affichable
 * (l'erreur inattendue, elle, est relancée vers la limite d'erreur).
 */
export async function settle<T>(load: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await load() };
  } catch (error) {
    if (!isApiError(error)) throw error;
    return { ok: false, message: describeApiError(error), status: error.status };
  }
}
