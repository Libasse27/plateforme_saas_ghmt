import { isApiError } from '@/lib/api/errors';
import { describeApiError, fieldErrorsFromApi } from '@/lib/api/messages';
import type { FormState } from '@/lib/forms';
import { toDuplicateCandidates } from '@/lib/domain/mappers';

/**
 * Convertit une erreur d'API en état de formulaire français. Les erreurs inattendues
 * (bogues) sont relancées vers la limite d'erreur plutôt qu'avalées.
 */
export function failureState(error: unknown, values?: Readonly<Record<string, string>>): FormState {
  if (!isApiError(error)) throw error;
  const candidates = error.code === 'patient_duplicate' ? toDuplicateCandidates(error.extras) : [];
  const forceable = error.code === 'patient_duplicate' || error.code === 'patient_duplicate_out_of_scope';
  return {
    ok: false,
    message: describeApiError(error),
    fieldErrors: fieldErrorsFromApi(error.errors),
    values,
    extra: forceable ? { candidates, forceable: true } : undefined,
  };
}

export function invalidState(fieldErrors: Record<string, string>, values: Record<string, string>): FormState {
  return { ok: false, message: 'Certains champs sont invalides. Corrigez-les puis réessayez.', fieldErrors, values };
}
