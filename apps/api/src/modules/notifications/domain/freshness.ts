import type { NotificationTypeCode, SuppressionReason } from '@ghmt/shared';

export interface AppointmentState {
  readonly status: string;
  readonly startsAt: Date;
  readonly deletedAt: Date | null;
}

const REMINDER_STATUSES: ReadonlySet<string> = new Set(['scheduled', 'confirmed']);
const REMINDER_TYPES: ReadonlySet<string> = new Set(['appointment.reminder_d1', 'appointment.reminder_h2']);

/**
 * Fraîcheur à l'envoi (docs/10 D8). Rappel : rendez-vous non supprimé, `scheduled` ou `confirmed`, et `starts_at` égal à la
 * version prévue (on ne compare pas `row_version`, qu'une confirmation incrémente sans rendre le rappel faux). Confirmation
 * et report : ni annulé ni supprimé, et horaire inchangé (sinon le message annoncerait une heure fausse). Avis d'annulation : toujours émis.
 */
export function appointmentSuppression(
  typeCode: NotificationTypeCode,
  subjectVersion: string | null,
  appointment: AppointmentState | null,
): SuppressionReason | null {
  if (typeCode === 'appointment.cancelled') return null;
  if (!appointment) return 'stale';
  if (appointment.deletedAt !== null || appointment.status === 'cancelled') return 'appointment_cancelled';
  if (!REMINDER_TYPES.has(typeCode)) return appointment.startsAt.toISOString() === subjectVersion ? null : 'stale';
  if (!REMINDER_STATUSES.has(appointment.status)) return 'stale';
  return appointment.startsAt.toISOString() === subjectVersion ? null : 'stale';
}
