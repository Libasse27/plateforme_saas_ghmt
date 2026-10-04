import type { DuplicateCandidate } from '@ghmt/shared';
import type { Patient } from '../../../generated/prisma/client';
import type { FieldCrypto } from '../../../common/crypto/field-crypto.service';
import { formatPatientFullName } from '../domain/patient-identity';

export type PatientRow = Patient;

export interface PatientSummary {
  readonly id: string;
  readonly ipp: string;
  readonly lastName: string;
  readonly firstName: string;
  readonly sex: string;
  readonly birthDate: string | null;
  readonly birthDateEstimated: boolean;
  readonly city: string | null;
}

export interface PatientDetail extends PatientSummary {
  readonly bloodGroup: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly nationalId: string | null;
  readonly address: string | null;
  /** Vrai quand la projection « identité seule » masque téléphone, e-mail, pièce et adresse. */
  readonly contactRedacted: boolean;
  readonly primarySiteId: string | null;
  readonly deceasedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly rowVersion: number;
}

function toDateOnly(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

/** Projection de liste : aucun champ chiffré, même déchiffré. */
export function toPatientSummary(row: PatientRow): PatientSummary {
  return {
    id: row.id,
    ipp: row.ipp,
    lastName: row.lastName,
    firstName: row.firstName,
    sex: row.sex,
    birthDate: toDateOnly(row.birthDate),
    birthDateEstimated: row.birthDateEstimated,
    city: row.city,
  };
}

export interface DetailOptions {
  /**
   * Coordonnées et pièce d'identité (téléphone, e-mail, pièce, adresse) déchiffrées et renvoyées.
   * Sinon projection « identité seule » : ces champs ne sont même pas déchiffrés (renvoyés à null).
   */
  readonly includeContact: boolean;
}

/** Fiche : déchiffre phone, email, nationalId, address selon `includeContact` ; jamais de `*_enc` ni `*_bidx`. */
export function toPatientDetail(row: PatientRow, crypto: FieldCrypto, options: DetailOptions = { includeContact: true }): PatientDetail {
  const decrypt = (blob: Uint8Array | null): string | null =>
    options.includeContact ? (crypto.decryptOptional(row.tenantId, blob) ?? null) : null;
  return {
    ...toPatientSummary(row),
    bloodGroup: row.bloodGroup,
    phone: decrypt(row.phoneEnc),
    email: decrypt(row.emailEnc),
    nationalId: decrypt(row.nationalIdEnc),
    address: decrypt(row.addressEnc),
    contactRedacted: !options.includeContact,
    primarySiteId: row.primarySiteId,
    deceasedAt: row.deceasedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    rowVersion: row.rowVersion,
  };
}

export type DuplicateCandidateRow = Pick<PatientRow, 'id' | 'ipp' | 'firstName' | 'lastName' | 'birthDate'>;

export const DUPLICATE_CANDIDATE_SELECT = { id: true, ipp: true, firstName: true, lastName: true, birthDate: true } as const;

/** Candidat de doublon : identité minimale (pas de date complète, pas de coordonnées). */
export function toDuplicateCandidate(row: DuplicateCandidateRow): DuplicateCandidate {
  return {
    id: row.id,
    ipp: row.ipp,
    fullName: formatPatientFullName(row.firstName, row.lastName),
    birthYear: row.birthDate ? row.birthDate.getUTCFullYear() : null,
  };
}
