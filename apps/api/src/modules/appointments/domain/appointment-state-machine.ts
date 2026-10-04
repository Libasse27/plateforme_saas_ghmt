import type { AppointmentStatus } from '@ghmt/shared';
import { DomainError } from '../../../common/errors/domain-error';

const TRANSITIONS: Readonly<Record<AppointmentStatus, readonly AppointmentStatus[]>> = {
  requested: [],
  scheduled: ['confirmed', 'cancelled', 'no_show', 'checked_in'],
  confirmed: ['checked_in', 'cancelled', 'no_show'],
  checked_in: ['in_progress', 'cancelled'],
  in_progress: ['completed'],
  completed: [],
  cancelled: [],
  no_show: [],
};

export function allowedTransitions(from: AppointmentStatus): readonly AppointmentStatus[] {
  return TRANSITIONS[from];
}

export function canTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: AppointmentStatus, to: AppointmentStatus): void {
  if (!canTransition(from, to)) {
    throw DomainError.conflict('invalid_transition', `Transition de statut interdite : ${from} vers ${to}.`);
  }
}
