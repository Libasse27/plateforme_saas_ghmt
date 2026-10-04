import { APPOINTMENT_STATUSES, type AppointmentStatus } from '@ghmt/shared';

/** Statut affiché : `unknown` = valeur non reconnue de l'API (défaut fermé, aucune action). */
export type DisplayStatus = AppointmentStatus | 'unknown';

export type StatusAction = 'confirm' | 'check_in' | 'cancel';

export interface StatusActionSpec {
  readonly action: StatusAction;
  readonly status: AppointmentStatus;
  readonly label: string;
}

const ACTIONS: Readonly<Record<StatusAction, StatusActionSpec>> = {
  confirm: { action: 'confirm', status: 'confirmed', label: 'Confirmer' },
  check_in: { action: 'check_in', status: 'checked_in', label: 'Arrivé' },
  cancel: { action: 'cancel', status: 'cancelled', label: 'Annuler' },
};

const ALLOWED: Readonly<Partial<Record<AppointmentStatus, readonly StatusAction[]>>> = {
  scheduled: ['confirm', 'check_in', 'cancel'],
  confirmed: ['check_in', 'cancel'],
  checked_in: ['cancel'],
};

/** Actions de changement de statut proposées à l'accueil selon le statut courant. */
export function allowedStatusActions(status: DisplayStatus): readonly StatusActionSpec[] {
  if (status === 'unknown') return [];
  return (ALLOWED[status] ?? []).map((action) => ACTIONS[action]);
}

export function isAppointmentStatus(value: unknown): value is AppointmentStatus {
  return typeof value === 'string' && (APPOINTMENT_STATUSES as readonly string[]).includes(value);
}

export const ACTIVE_STATUSES: readonly DisplayStatus[] = ['requested', 'scheduled', 'confirmed', 'checked_in', 'in_progress'];

/** L'API valide `startsAt`/`endsAt`, le formulaire saisit date + heure + durée : on rabat ces erreurs sur « time ». */
export function remapSlotErrors(errors: Readonly<Record<string, string>>): Record<string, string> {
  const { startsAt, endsAt, ...rest } = errors;
  const timeError = startsAt ?? endsAt;
  return timeError ? { ...rest, time: rest.time ?? timeError } : { ...rest };
}
