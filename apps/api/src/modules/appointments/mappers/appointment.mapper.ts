import type { Appointment } from '../../../generated/prisma/client';
import { formatPatientFullName } from '../../patients/domain/patient-identity';

export interface AppointmentPatientRef {
  readonly id: string;
  readonly ipp: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly birthDate: Date | null;
  readonly deceasedAt: Date | null;
  readonly primarySiteId: string | null;
}

export interface AppointmentPractitionerRef {
  readonly id: string;
  readonly fullName: string;
  readonly specialty: string | null;
  readonly departmentId: string | null;
}

export type AppointmentRow = Appointment & {
  readonly patient: AppointmentPatientRef;
  readonly practitioner: AppointmentPractitionerRef;
};

/** Relations lues avec chaque rendez-vous (identité minimale du patient, jamais de coordonnées). */
export const APPOINTMENT_INCLUDE = {
  patient: { select: { id: true, ipp: true, firstName: true, lastName: true, birthDate: true, deceasedAt: true, primarySiteId: true } },
  practitioner: { select: { id: true, fullName: true, specialty: true, departmentId: true } },
} as const;

export interface AppointmentView {
  readonly id: string;
  readonly patientId: string;
  readonly practitionerId: string;
  readonly siteId: string;
  readonly patient: {
    readonly id: string;
    readonly ipp: string;
    /** « Prénom NOM ». */
    readonly fullName: string;
    readonly birthYear: number | null;
    /** Date de décès (ISO) ou null. */
    readonly deceasedAt: string | null;
  };
  readonly practitioner: { readonly id: string; readonly fullName: string; readonly specialty: string | null };
  readonly startsAt: string;
  readonly endsAt: string;
  readonly status: string;
  readonly source: string;
  /** Présents seulement pour qui détient `consultations:consultation:read` (motif de consultation = donnée clinique). */
  readonly reason?: string | null;
  readonly cancelReason?: string | null;
  readonly checkedInAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly rowVersion: number;
}

export interface ViewOptions {
  readonly includeClinical: boolean;
}

export function toAppointmentView(row: AppointmentRow, options: ViewOptions): AppointmentView {
  return {
    id: row.id,
    patientId: row.patientId,
    practitionerId: row.practitionerId,
    siteId: row.siteId,
    patient: {
      id: row.patient.id,
      ipp: row.patient.ipp,
      fullName: formatPatientFullName(row.patient.firstName, row.patient.lastName),
      birthYear: row.patient.birthDate ? row.patient.birthDate.getUTCFullYear() : null,
      deceasedAt: row.patient.deceasedAt?.toISOString() ?? null,
    },
    practitioner: { id: row.practitioner.id, fullName: row.practitioner.fullName, specialty: row.practitioner.specialty },
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    status: row.status,
    source: row.source,
    ...(options.includeClinical ? { reason: row.reason, cancelReason: row.cancelReason } : {}),
    checkedInAt: row.checkedInAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    rowVersion: row.rowVersion,
  };
}
