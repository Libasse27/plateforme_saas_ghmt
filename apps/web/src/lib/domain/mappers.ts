import { isAppointmentStatus, type DisplayStatus } from './appointments';

export interface PatientView {
  readonly id: string;
  readonly fullName: string;
  readonly lastName: string;
  readonly firstName: string;
  readonly recordNumber: string;
  readonly sex: string;
  readonly birthDate: string;
  readonly birthDateEstimated: boolean;
  readonly city: string;
  readonly phone: string;
  readonly email: string;
  readonly address: string;
  readonly bloodGroup: string;
  /** Date de décès (ISO) ou null. */
  readonly deceasedAt: string | null;
  /** Coordonnées masquées par les droits de l'appelant : « vide » ne veut pas dire « non renseigné ». */
  readonly contactRedacted: boolean;
}

export interface AppointmentView {
  readonly id: string;
  readonly status: DisplayStatus;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly reason: string;
  readonly patientId: string;
  readonly patientName: string;
  readonly patientIpp: string;
  readonly patientBirthYear: number | null;
  readonly patientDeceasedAt: string | null;
  readonly practitionerId: string;
  readonly practitionerName: string;
  readonly practitionerSpecialty: string;
}

export interface PractitionerView {
  readonly id: string;
  readonly fullName: string;
  readonly specialty: string;
}

export interface SiteView {
  readonly id: string;
  readonly name: string;
  readonly city: string;
}

type UnknownRecord = Record<string, unknown>;

function rec(value: unknown): UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as UnknownRecord) : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function first(...values: unknown[]): string {
  return values.map(str).find((v) => v.length > 0) ?? '';
}

/** Nom d'affichage « Prénom NOM » (nom de famille en majuscules). */
export function formatPersonName(firstName: unknown, lastName: unknown): string {
  return [str(firstName).trim(), str(lastName).trim().toUpperCase()].filter(Boolean).join(' ');
}

function nullableDate(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** L'adresse peut être une chaîne (schéma partagé) ou un objet { line1, city, country } (docs/03). */
function formatAddress(address: unknown, city: unknown): string {
  if (typeof address === 'string') return [address, str(city)].filter(Boolean).join(', ');
  const a = rec(address);
  return [str(a.line1), str(a.line2), first(a.city, city), str(a.country)].filter(Boolean).join(', ');
}

export function toPatient(raw: unknown): PatientView {
  const p = rec(raw);
  const lastName = str(p.lastName);
  const firstName = str(p.firstName);
  return {
    id: str(p.id),
    lastName,
    firstName,
    fullName: first(p.fullName, formatPersonName(firstName, lastName)) || 'Patient sans nom',
    recordNumber: first(p.medicalRecordNumber, p.ipp, p.recordNumber),
    sex: str(p.sex),
    birthDate: str(p.birthDate),
    birthDateEstimated: p.birthDateEstimated === true,
    city: str(p.city),
    phone: str(p.phone),
    email: str(p.email),
    address: formatAddress(p.address, p.city),
    bloodGroup: str(p.bloodGroup),
    deceasedAt: nullableDate(p.deceasedAt),
    contactRedacted: p.contactRedacted === true,
  };
}

export function toPractitioner(raw: unknown): PractitionerView {
  const p = rec(raw);
  return { id: str(p.id), fullName: first(p.fullName, p.name) || 'Praticien', specialty: str(p.specialty) };
}

export function toSite(raw: unknown): SiteView {
  const s = rec(raw);
  return { id: str(s.id), name: first(s.name, s.code) || 'Site', city: str(s.city) };
}

export function toAppointment(raw: unknown): AppointmentView {
  const a = rec(raw);
  const patient = rec(a.patient);
  const practitioner = rec(a.practitioner);
  const status = a.status;
  return {
    id: str(a.id),
    status: isAppointmentStatus(status) ? status : 'unknown',
    startsAt: str(a.startsAt),
    endsAt: str(a.endsAt),
    reason: str(a.reason),
    patientId: first(a.patientId, patient.id),
    patientName: first(patient.fullName, a.patientName, formatPersonName(patient.firstName, patient.lastName)) || 'Patient',
    patientIpp: first(patient.ipp, patient.medicalRecordNumber),
    patientBirthYear: typeof patient.birthYear === 'number' ? patient.birthYear : null,
    patientDeceasedAt: nullableDate(patient.deceasedAt),
    practitionerId: first(a.practitionerId, practitioner.id),
    practitionerName: first(practitioner.fullName, a.practitionerName) || 'Praticien',
    practitionerSpecialty: str(practitioner.specialty),
  };
}

export function toList<T>(raw: unknown, mapper: (item: unknown) => T): T[] {
  if (Array.isArray(raw)) return raw.map(mapper);
  const items = rec(raw).items;
  return Array.isArray(items) ? items.map(mapper) : [];
}

export interface DuplicateCandidate {
  readonly id: string;
  readonly fullName: string;
  readonly recordNumber: string;
  readonly birthYear: number | null;
}

/** Candidats d'un 409 patient_duplicate (C3) : `details.candidates`, ou `candidates` à la racine. */
const MAX_CANDIDATES = 5;

export function toDuplicateCandidates(extras: Readonly<Record<string, unknown>>): DuplicateCandidate[] {
  const candidates = Array.isArray(extras.candidates) ? extras.candidates : rec(extras.details).candidates;
  if (!Array.isArray(candidates)) return [];
  return candidates
    .map((c) => {
      const r = rec(c);
      return { id: str(r.id), fullName: first(r.fullName, r.name, formatPersonName(r.firstName, r.lastName)), recordNumber: first(r.medicalRecordNumber, r.ipp, r.recordNumber), birthYear: typeof r.birthYear === 'number' ? r.birthYear : null };
    })
    .filter((c) => c.id.length > 0);
}

export function groupByPractitioner(
  appointments: readonly AppointmentView[],
  practitioners: readonly PractitionerView[],
): { practitioner: PractitionerView; appointments: AppointmentView[] }[] {
  const known = new Set(practitioners.map((p) => p.id));
  const extra = appointments
    .filter((a) => !known.has(a.practitionerId))
    .map((a): PractitionerView => ({ id: a.practitionerId, fullName: a.practitionerName, specialty: a.practitionerSpecialty }));
  const uniqueExtra = [...new Map(extra.map((p) => [p.id, p])).values()];
  return [...practitioners, ...uniqueExtra]
    .map((practitioner) => ({
      practitioner,
      appointments: appointments
        .filter((a) => a.practitionerId === practitioner.id)
        .sort((x, y) => x.startsAt.localeCompare(y.startsAt)),
    }))
    .filter((group) => group.appointments.length > 0 || known.has(group.practitioner.id));
}

/** Relit des candidats renvoyés par le formulaire (JSON) en les re-normalisant ; JSON invalide ⇒ liste vide. */
export function parseCandidatesJson(raw: string | undefined): DuplicateCandidate[] {
  if (!raw) return [];
  try {
    return toDuplicateCandidates({ candidates: JSON.parse(raw) as unknown }).slice(0, MAX_CANDIDATES);
  } catch {
    return [];
  }
}
