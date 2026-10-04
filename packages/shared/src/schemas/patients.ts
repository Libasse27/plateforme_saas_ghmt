/**
 * Schémas Zod propres au module patients.
 * Chaque équipe de module n'édite que son propre fichier ; les schémas communs restent dans ./index.ts.
 */
import { z } from 'zod';
import { email, isoDate, phoneE164, uuid } from './primitives';

export const SEXES = ['male', 'female', 'other', 'unknown'] as const;
export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;

/** Âge maximal plausible d'un patient (années). */
export const MAX_PATIENT_AGE_YEARS = 130;
export const IPP_PATTERN = /^P\d{2}-\d{7}$/;
export const REASON_MIN_LENGTH = 3;
export const REASON_MAX_LENGTH = 500;

/**
 * Date de naissance plausible : au plus demain (UTC, tolérance pour les fuseaux en avance sur UTC) et au plus 130 ans.
 * Le contrôle exact « ≤ aujourd'hui dans le fuseau de l'établissement » est fait côté API.
 */
const birthDate = isoDate.refine(
  (value) => {
    const today = new Date();
    const oldest = new Date(Date.UTC(today.getUTCFullYear() - MAX_PATIENT_AGE_YEARS, today.getUTCMonth(), today.getUTCDate()));
    const latest = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1));
    return value <= latest.toISOString().slice(0, 10) && value >= oldest.toISOString().slice(0, 10);
  },
  { message: `date de naissance future ou âge supérieur à ${MAX_PATIENT_AGE_YEARS} ans` },
);

const reason = z.string().trim().min(REASON_MIN_LENGTH).max(REASON_MAX_LENGTH);

/** Champs patient sans valeurs par défaut (sinon un PATCH partiel écraserait sexe et date estimée). */
const patientFieldsSchema = z.object({
  lastName: z.string().trim().min(1).max(100),
  firstName: z.string().trim().min(1).max(100),
  birthDate: birthDate.optional(),
  birthDateEstimated: z.boolean(),
  sex: z.enum(SEXES),
  bloodGroup: z.enum(BLOOD_GROUPS).optional(),
  phone: phoneE164.optional(),
  email: email.optional(),
  nationalId: z.string().min(3).max(50).optional(),
  address: z.string().max(500).optional(),
  city: z.string().max(100).optional(),
  primarySiteId: uuid.optional(),
});

export const createPatientSchema = patientFieldsSchema
  .extend({
    birthDateEstimated: z.boolean().default(false),
    sex: z.enum(SEXES).default('unknown'),
    /** Motif du forçage d'un doublon probable (obligatoire avec `?force=true`, contrôlé par le service). */
    forceReason: reason.optional(),
  })
  .refine((v) => !v.birthDateEstimated || v.birthDate !== undefined, {
    message: 'birthDate est requis lorsque la date est estimée',
    path: ['birthDate'],
  });
export type CreatePatientInput = z.infer<typeof createPatientSchema>;

/** `null` efface la valeur (téléphone, e-mail, pièce d'identité, adresse, ville, groupe sanguin). */
export const updatePatientSchema = patientFieldsSchema.partial().extend({
  bloodGroup: z.enum(BLOOD_GROUPS).nullable().optional(),
  phone: phoneE164.nullable().optional(),
  email: email.nullable().optional(),
  nationalId: z.string().min(3).max(50).nullable().optional(),
  address: z.string().max(500).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
});
export type UpdatePatientInput = z.infer<typeof updatePatientSchema>;

/** Suppression d'un patient : motif obligatoire (C5). */
export const deletePatientSchema = z.object({ reason });
export type DeletePatientInput = z.infer<typeof deletePatientSchema>;

/** Paramètre de requête `?force=true` : contourne la détection de doublon probable à la création. */
export const createPatientQuerySchema = z.object({
  force: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});
export type CreatePatientQuery = z.infer<typeof createPatientQuerySchema>;

/**
 * Recherche par POST (C1) : aucun terme de recherche dans une URL.
 * L'exigence d'au moins un critère est contrôlée par le service (422 `search_criteria_required`).
 */
export const searchPatientsSchema = z.object({
  q: z.string().min(2).max(100).optional(),
  phone: phoneE164.optional(),
  ipp: z.string().regex(IPP_PATTERN, 'IPP au format P26-0000042').optional(),
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().max(200).optional(),
});
export type SearchPatientsInput = z.infer<typeof searchPatientsSchema>;

/** Candidat de doublon renvoyé par 409 `patient_duplicate` (`details.candidates`, 5 au plus). */
export interface DuplicateCandidate {
  readonly id: string;
  readonly ipp: string;
  readonly fullName: string;
  readonly birthYear: number | null;
}
