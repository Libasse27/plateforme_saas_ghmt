import { formatBirthDate } from '@/lib/format/dates';
import { SEX_LABELS } from './labels';
import type { PatientView } from './mappers';

export const CONTACT_REDACTED_LABEL = 'Coordonnées masquées (droits insuffisants)';

/** Lignes de la fiche : une coordonnée masquée par les droits n'est pas « non renseignée ». */
export function patientSheetRows(patient: PatientView): readonly (readonly [string, string])[] {
  const contact = (value: string): string => (patient.contactRedacted && !value ? CONTACT_REDACTED_LABEL : value);
  return [
    ['N° de dossier', patient.recordNumber],
    ['Sexe', SEX_LABELS[patient.sex] ?? ''],
    ['Date de naissance', patient.birthDate && patient.birthDateEstimated ? `${formatBirthDate(patient.birthDate)} (date estimée)` : formatBirthDate(patient.birthDate)],
    ['Téléphone', contact(patient.phone)],
    ['E-mail', contact(patient.email)],
    ['Adresse', contact(patient.address)],
    ['Groupe sanguin', patient.bloodGroup],
  ];
}

/** Bandeau « Patient décédé le … » (null si le patient n'est pas décédé). */
export function deceasedBanner(patient: Pick<PatientView, 'deceasedAt'>): string | null {
  if (!patient.deceasedAt) return null;
  const date = formatBirthDate(patient.deceasedAt);
  return date ? `Patient décédé le ${date}` : 'Patient décédé';
}
