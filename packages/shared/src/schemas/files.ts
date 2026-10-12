// Documents du patient (docs/13 §7) : constantes et schémas partagés par l'API et le web.
import { z } from 'zod';
import { isoDateTime, uuid } from './primitives';

/** Taille maximale d'un document déposé (docs/13 D3) : 10 Mo. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Types acceptés, détectés sur le contenu et non sur l'extension (docs/13 D8). */
export const ALLOWED_UPLOAD_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const;
export type AllowedUploadType = (typeof ALLOWED_UPLOAD_TYPES)[number];

/** Usages des documents administratifs du patient (D7) ; les documents cliniques arrivent en P17. */
export const filePurposeSchema = z.enum(['identity', 'insurance_card', 'administrative']);
export type FilePurpose = z.infer<typeof filePurposeSchema>;

export const fileStatusSchema = z.enum(['pending', 'available', 'rejected', 'deleted']);
export type FileStatus = z.infer<typeof fileStatusSchema>;

/** Statuts visibles dans la fiche patient : un fichier `pending` est affiché « Analyse en cours », sans téléchargement. */
const visibleStatusSchema = fileStatusSchema.extract(['available', 'pending']);

export const patientDocumentViewSchema = z.object({
  id: uuid,
  purpose: filePurposeSchema,
  status: visibleStatusSchema,
  originalName: z.string().min(1).max(200),
  mimeType: z.enum(ALLOWED_UPLOAD_TYPES),
  sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  createdAt: isoDateTime,
  createdBy: z.object({ id: uuid, fullName: z.string() }),
});
export type PatientDocumentView = z.infer<typeof patientDocumentViewSchema>;

const DELETE_REASON_MIN_LENGTH = 5;
const DELETE_REASON_MAX_LENGTH = 500;

/** Suppression d'un document : motif obligatoire, consigné dans l'audit (`files.file.deleted`). */
export const deleteDocumentSchema = z.object({
  reason: z.string().trim().min(DELETE_REASON_MIN_LENGTH).max(DELETE_REASON_MAX_LENGTH),
});
export type DeleteDocumentInput = z.infer<typeof deleteDocumentSchema>;
