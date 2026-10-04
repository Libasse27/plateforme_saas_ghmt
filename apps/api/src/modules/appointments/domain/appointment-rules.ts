import type { AppointmentStatus } from '@ghmt/shared';
import { DomainError } from '../../../common/errors/domain-error';
import { localDateKey } from '../../../common/time/local-date';

/** Statuts dans lesquels un rendez-vous peut encore être supprimé (A10). */
export const DELETABLE_STATUSES: readonly AppointmentStatus[] = ['scheduled', 'confirmed'];
/**
 * Transitions interdites pour un patient décédé (annuler / marquer absent reste possible).
 * Une consultation déjà commencée (`in_progress`, `completed`) doit pouvoir être poursuivie et clôturée.
 */
const CARE_TRANSITIONS: readonly AppointmentStatus[] = ['confirmed', 'checked_in'];

export { localDateKey };

export interface TransitionTiming {
  readonly now: Date;
  readonly startsAt: Date;
  readonly timeZone: string;
}

function invalidTransition(detail: string): DomainError {
  return DomainError.conflict('invalid_transition', detail);
}

/** Règles horaires : absence constatée seulement après l'heure de début ; arrivée seulement le jour J. */
export function assertTransitionTiming(to: AppointmentStatus, timing: TransitionTiming): void {
  if (to === 'no_show' && timing.now < timing.startsAt) {
    throw invalidTransition('Une absence ne peut être constatée qu’après l’heure de début du rendez-vous.');
  }
  if (to === 'checked_in' && localDateKey(timing.now, timing.timeZone) !== localDateKey(timing.startsAt, timing.timeZone)) {
    throw invalidTransition('L’arrivée ne peut être enregistrée que le jour du rendez-vous.');
  }
}

export function assertDeletable(status: AppointmentStatus): void {
  if (!DELETABLE_STATUSES.includes(status)) {
    throw invalidTransition('Seul un rendez-vous planifié ou confirmé peut être supprimé ; annulez-le sinon.');
  }
}

export function assertSlotNotInPast(startsAt: Date, now: Date): void {
  if (startsAt < now) throw DomainError.unprocessable('slot_in_past', 'Le créneau demandé est dans le passé.');
}

export function assertPatientAlive(patient: { readonly deceasedAt: Date | null }): void {
  if (patient.deceasedAt) throw DomainError.unprocessable('patient_deceased', 'Ce patient est enregistré comme décédé.');
}

export function requiresLivingPatient(to: AppointmentStatus): boolean {
  return CARE_TRANSITIONS.includes(to);
}
