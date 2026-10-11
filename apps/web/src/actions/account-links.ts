import { isApiError } from '@/lib/api/errors';
import { publicRequest } from '@/server/api';
import type { FormState } from '@/lib/forms';
import { failureState } from './helpers';

/**
 * Demande « sans oracle » (mot de passe oublié, renvoi de vérification) : succès et 404 donnent exactement le même
 * état, pour que la réponse ne révèle rien sur l'existence du compte. Les autres erreurs (limitation, panne) sont dites.
 */
export async function acceptedWithoutOracle(
  path: string,
  body: Record<string, string>,
  message: string,
  values: Record<string, string>,
): Promise<FormState> {
  try {
    await publicRequest(path, { method: 'POST', body });
  } catch (error) {
    if (!(isApiError(error) && error.status === 404)) return failureState(error, values);
  }
  return { ok: true, message };
}
