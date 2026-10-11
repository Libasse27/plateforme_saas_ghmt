import { redirect } from 'next/navigation';
import { isApiError } from '@/lib/api/errors';
import { describeApiError, fieldErrorsFromApi, type DescribeOptions } from '@/lib/api/messages';
import type { FormState } from '@/lib/forms';
import { toDuplicateCandidates } from '@/lib/domain/mappers';

const MFA_ENROLMENT_PATH = '/securite/mfa';

/**
 * Convertit une erreur d'API en état de formulaire français. Les erreurs inattendues
 * (bogues) sont relancées vers la limite d'erreur plutôt qu'avalées.
 */
export function failureState(error: unknown, values?: Readonly<Record<string, string>>, options?: DescribeOptions): FormState {
  if (!isApiError(error)) throw error;
  // Contexte établissement (offNetwork renseigné) : l'enrôlement est la seule suite possible. On y redirige, sauf si
  // des valeurs saisies seraient perdues : le message et un lien d'activation sont alors renvoyés au formulaire.
  if (error.code === 'mfa_enrollment_required' && typeof error.extras.offNetwork === 'boolean') {
    if (!values || Object.keys(values).length === 0) redirect(MFA_ENROLMENT_PATH);
    return { ok: false, message: describeApiError(error, options), values, extra: { mfaEnrolmentPath: MFA_ENROLMENT_PATH } };
  }
  const candidates = error.code === 'patient_duplicate' ? toDuplicateCandidates(error.extras) : [];
  const forceable = error.code === 'patient_duplicate' || error.code === 'patient_duplicate_out_of_scope';
  return {
    ok: false,
    message: describeApiError(error, options),
    fieldErrors: fieldErrorsFromApi(error.errors),
    values,
    extra: forceable ? { candidates, forceable: true } : undefined,
  };
}

export function invalidState(fieldErrors: Record<string, string>, values: Record<string, string>): FormState {
  return { ok: false, message: 'Certains champs sont invalides. Corrigez-les puis réessayez.', fieldErrors, values };
}
