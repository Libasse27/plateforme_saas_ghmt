import type { ApiError } from './errors';
import type { FieldIssue } from './types';

export const GENERIC_ERROR = 'Une erreur est survenue. Veuillez réessayer.';

const BY_CODE: Readonly<Record<string, string>> = {
  invalid_credentials: 'Identifiants invalides. Vérifiez le code établissement, l\'e-mail et le mot de passe.',
  patient_duplicate: 'Un patient très proche existe déjà. Vérifiez les dossiers ci-dessous avant d\'en créer un nouveau.',
  patient_duplicate_out_of_scope: 'Un dossier correspondant existe dans un autre site. Vérifiez auprès de l\'identitovigilance ou créez le dossier en indiquant un motif.',
  invalid_transition: 'Ce changement de statut n\'est plus possible pour ce rendez-vous. Actualisez la page.',
  concurrent_update: 'Cet élément vient d\'être modifié par quelqu\'un d\'autre. Actualisez la page puis réessayez.',
  duplicate: 'Cet élément existe déjà.',
  precondition_failed: 'Cette fiche a été modifiée entre-temps. Rechargez-la avant de réessayer.',
  precondition_required: 'Rechargez la page avant de modifier cette fiche.',
  force_reason_required: 'Indiquez le motif pour créer le dossier malgré le doublon suspecté.',
  search_criteria_required: 'Saisissez au moins un critère de recherche (nom, téléphone ou numéro de dossier).',
  password_change_required: 'Vous devez changer votre mot de passe avant de continuer.',
  invitation_expired: 'Cette invitation est expirée ou n\'est plus valide. Demandez-en une nouvelle à votre administrateur.',
  invalid_password: 'Le mot de passe actuel est incorrect.',
  slot_unavailable: 'Ce créneau vient d\'être réservé. Choisissez un autre horaire.',
  network_error: 'Service injoignable. Vérifiez votre connexion et réessayez.',
  timeout: 'Le service met trop de temps à répondre. Réessayez dans un instant.',
  mfa_invalid_code: 'Code invalide ou expiré.',
  invalid_mfa_code: 'Code invalide ou expiré.',
  subscription_suspended: 'L\'abonnement de l\'établissement est suspendu. Contactez votre administrateur.',
  module_not_subscribed: 'Ce module n\'est pas activé pour votre établissement.',
};

const BY_STATUS: Readonly<Record<number, string>> = {
  400: 'Requête invalide. Vérifiez les informations saisies.',
  401: 'Votre session a expiré. Veuillez vous reconnecter.',
  403: 'Vous n\'avez pas l\'autorisation d\'effectuer cette action.',
  404: 'Élément introuvable.',
  409: 'Cette opération est en conflit avec des données existantes (doublon, créneau déjà pris ou statut incompatible).',
  422: 'Certains champs sont invalides. Corrigez-les puis réessayez.',
  423: 'Cet élément est verrouillé et ne peut pas être modifié.',
  410: 'Ce lien n\'est plus valide.',
  412: 'Cette fiche a été modifiée entre-temps. Rechargez-la avant de réessayer.',
  428: 'Rechargez la page avant de modifier cette fiche.',
  429: 'Trop de tentatives. Patientez un instant avant de réessayer.',
};

/** Message lisible en français pour l'utilisateur ; ne divulgue jamais de détail technique. */
export function describeApiError(error: Pick<ApiError, 'status' | 'code'>): string {
  const byCode = BY_CODE[error.code];
  if (byCode) return byCode;
  const byStatus = BY_STATUS[error.status];
  if (byStatus) return byStatus;
  if (error.status >= 500) return 'Le service rencontre un problème. Réessayez dans quelques minutes.';
  return GENERIC_ERROR;
}

/** Erreurs de champ renvoyées par l'API (422), indexées par chemin ; première erreur par champ. */
export function fieldErrorsFromApi(issues: readonly FieldIssue[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const issue of issues) {
    if (!(issue.path in result)) result[issue.path] = issue.message;
  }
  return result;
}
