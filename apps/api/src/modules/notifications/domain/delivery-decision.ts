import type { NotificationCategory, NotificationChannel, NotificationTypeCode, SuppressionReason } from '@ghmt/shared';
import { appointmentSuppression, type AppointmentState } from './freshness';

export interface DecisionInput {
  readonly now: Date;
  readonly typeCode: NotificationTypeCode;
  readonly category: NotificationCategory;
  readonly channel: NotificationChannel;
  readonly deadlineAt: Date | null;
  readonly subjectVersion: string | null;
  /** État courant du rendez-vous sujet (`null` : introuvable) ; ignoré si `expectsAppointment` est faux. */
  readonly appointment: AppointmentState | null;
  readonly expectsAppointment: boolean;
  readonly recipientActive: boolean;
  /** Adresse (téléphone ou e-mail) déchiffrée pour le canal ; `null` si le destinataire n'en a pas. */
  readonly address: string | null;
  /** Dernier consentement du canal accordé (rappels cliniques seulement). */
  readonly consentGranted: boolean;
  /** Préférence « e-mail administratif » du destinataire personnel (absente = activée). */
  readonly emailPreferenceEnabled: boolean;
  readonly appointmentSmsEnabled: boolean;
}

export type EarlyOutcome =
  | { readonly kind: 'suppress'; readonly reason: SuppressionReason }
  | { readonly kind: 'fail'; readonly errorCode: string; readonly errorClass: null };

const suppress = (reason: SuppressionReason): EarlyOutcome => ({ kind: 'suppress', reason });

/**
 * Contrôles de préparation sans effet de bord (docs/10 §5.8 b) : fraîcheur, destinataire actif, échéance, adresse,
 * consentement (rappels), réglage SMS transactionnel, préférence e-mail. Le premier motif rencontré gagne.
 */
export function decideEarly(input: DecisionInput): EarlyOutcome | null {
  if (input.expectsAppointment) {
    const stale = appointmentSuppression(input.typeCode, input.subjectVersion, input.appointment);
    if (stale) return suppress(stale);
  }
  if (!input.recipientActive) return suppress('recipient_inactive');
  if (input.deadlineAt !== null && input.now > input.deadlineAt) return { kind: 'fail', errorCode: 'deadline_exceeded', errorClass: null };
  if (input.channel !== 'inapp' && input.address === null) return suppress('no_contact');
  if (input.category === 'clinical_reminder' && !input.consentGranted) return suppress('no_consent');
  if (input.category === 'transactional' && input.channel === 'sms' && !input.appointmentSmsEnabled) return suppress('channel_disabled');
  const preferenceApplies = input.channel === 'email' && input.category === 'administrative' && !input.typeCode.startsWith('subscription.');
  if (preferenceApplies && !input.emailPreferenceEnabled) return suppress('preference_disabled');
  return null;
}
