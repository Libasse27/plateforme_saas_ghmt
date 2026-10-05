import type { ApiError } from './errors';
import { formatMoney } from '../domain/money';
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
  // Facturation patient, caisse et paiements
  payment_already_pending: 'Un paiement Mobile Money est déjà en attente pour cette facture. Terminez-le ou actualisez son statut avant d\'en lancer un autre.',
  cash_session_not_open: 'Cette session de caisse n\'est pas ouverte. Ouvrez une session de caisse avant d\'encaisser en espèces.',
  cash_session_not_owned: 'Les espèces doivent être encaissées sur votre propre session de caisse.',
  cash_session_already_open: 'Une session est déjà ouverte sur cette caisse.',
  cash_session_not_owner: 'Seul l\'utilisateur qui a ouvert la session peut la clôturer.',
  cash_session_not_closed: 'Cette session doit être clôturée avant d\'être validée.',
  invoice_not_payable: 'Cette facture ne peut pas être encaissée : elle n\'est pas émise, déjà soldée ou annulée.',
  invoice_not_draft: 'Cette facture n\'est plus un brouillon : elle ne peut plus être modifiée.',
  invoice_has_payments: 'Cette facture a des encaissements (réussis ou en attente) : elle ne peut pas être annulée.',
  invoice_already_void: 'Cette facture est déjà annulée.',
  free_line_forbidden: 'Vous n\'avez pas le droit d\'ajouter une ligne libre. Choisissez un article de la grille tarifaire.',
  price_list_code_taken: 'Ce code de grille tarifaire existe déjà.',
  price_list_item_code_taken: 'Ce code d\'article existe déjà dans cette grille.',
  cash_register_code_taken: 'Ce code de caisse existe déjà pour ce site.',
  site_out_of_scope: 'Ce site est hors de votre périmètre.',
  separation_of_duties: 'La validation doit être faite par un autre utilisateur que celui qui a ouvert ou clôturé la session (séparation des tâches).',
  amount_scale: 'Cette devise n\'a pas de subdivision : saisissez un montant entier, sans décimales.',
  payment_provider_unavailable: 'Le fournisseur de paiement est momentanément indisponible. Réessayez dans quelques minutes ou choisissez un autre mode de paiement.',
  invoice_not_issued: 'Cette facture n\'est pas encore émise : le reçu n\'est disponible qu\'après émission.',
  cash_register_site_mismatch: 'La caisse de votre session n\'est pas sur le même site que la facture. Ouvrez une session sur une caisse du site de la facture.',
  payment_not_pending: 'Ce paiement n\'est plus en attente : actualisez la page.',
  // Abonnement SaaS
  no_change: 'Vous êtes déjà sur ce plan avec cette périodicité.',
  invalid_state: 'Cette action n\'est pas possible dans l\'état actuel de l\'abonnement.',
  subscription_grace: 'Votre abonnement est en période de grâce : cette action est bloquée jusqu\'au règlement de la facture en retard.',
  payments_unavailable: 'Le service de paiement est momentanément indisponible. Réessayez dans quelques minutes.',
  plan_not_allowed_in_trial: 'Cette offre n\'est pas disponible pendant la période d\'essai. Choisissez-la après l\'essai.',
  // Console plateforme
  four_eyes_required: 'Règle des quatre yeux : la décision doit être prise par un autre administrateur que celui qui a saisi le paiement.',
  already_suspended: 'Cet établissement est déjà suspendu.',
  not_manually_suspended: 'Cet établissement n\'a pas été suspendu manuellement : sa suspension découle de son abonnement.',
  trial_already_extended: 'L\'essai a déjà été prolongé une fois.',
  not_in_trial: 'Cet abonnement n\'est pas en période d\'essai.',
  plan_version_conflict: 'Une autre version de ce plan vient d\'être créée. Actualisez la page.',
  amount_mismatch: 'Le montant doit être exactement celui de la facture.',
  manual_payment_pending: 'Un paiement manuel est déjà en attente de validation pour cette facture.',
  manual_payment_decided: 'Ce paiement manuel a déjà été validé ou rejeté.',
  invalid_code: 'Code invalide ou expiré.',
  mfa_not_pending: 'Aucun enrôlement en cours : recommencez la génération du QR code.',
  mfa_enrollment_required_cli: 'Ce compte doit d\'abord être activé par l\'équipe d\'exploitation (enrôlement du second facteur).',
  mfa_enrollment_required: 'Activez l\'authentification à deux facteurs pour accéder à la console plateforme.',
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
  429: 'Trop de tentatives, réessayez dans quelques instants.',
};

const METRIC_LABELS: Readonly<Record<string, string>> = { users: 'utilisateurs', sites: 'sites', appointmentsMonthly: 'rendez-vous du mois' };

export interface DescribeOptions {
  /** Devise d'affichage des montants cités dans le message (défaut : XOF). */
  readonly currency?: string;
}

type ErrorLike = Pick<ApiError, 'status' | 'code'> & { readonly extras?: Readonly<Record<string, unknown>> | undefined };

function detailsOf(error: ErrorLike): Record<string, unknown> {
  const details = error.extras?.details;
  return typeof details === 'object' && details !== null && !Array.isArray(details) ? (details as Record<string, unknown>) : {};
}

function violationText(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const { metric, limit, current } = entry as Record<string, unknown>;
  if (typeof metric !== 'string' || typeof limit !== 'number' || typeof current !== 'number') return null;
  return `${METRIC_LABELS[metric] ?? metric} : ${String(current)} en cours pour ${String(limit)} autorisé${limit > 1 ? 's' : ''}`;
}

/** Messages qui citent des valeurs du détail de l'erreur (reste dû, dépassements de plan). */
function describeWithDetails(error: ErrorLike, options: DescribeOptions): string | null {
  const details = detailsOf(error);
  if (error.code === 'amount_exceeds_balance') {
    const balance = typeof details.balance === 'string' ? formatMoney(details.balance, options.currency) : null;
    return balance && balance !== '-' ? `Le montant saisi dépasse le reste dû (${balance}).` : 'Le montant saisi dépasse le reste dû de la facture.';
  }
  if (error.code === 'downgrade_incompatible') {
    const lines = Array.isArray(details.violations) ? details.violations.map(violationText).filter((line): line is string => line !== null) : [];
    const base = 'Ce plan est incompatible avec votre usage actuel : réduisez-le sous les limites du nouveau plan avant de changer.';
    return lines.length > 0 ? `${base} Dépassements : ${lines.join(' ; ')}.` : base;
  }
  if (error.code === 'plan_limit_reached') {
    const metric = typeof details.metric === 'string' ? (METRIC_LABELS[details.metric] ?? details.metric) : null;
    return metric ? `La limite de votre plan est atteinte (${metric}). Passez à un plan supérieur.` : 'La limite de votre plan est atteinte. Passez à un plan supérieur.';
  }
  return null;
}

/** Message lisible en français pour l'utilisateur ; ne divulgue jamais de détail technique. */
export function describeApiError(error: ErrorLike, options: DescribeOptions = {}): string {
  const detailed = describeWithDetails(error, options);
  if (detailed) return detailed;
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
