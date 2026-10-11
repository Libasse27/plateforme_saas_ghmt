// Documents du patient (docs/13 §7) : constantes de la phase 0, schémas complétés par l'équipe DOC.

/** Taille maximale d'un document déposé (docs/13 D3) : 10 Mo. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Types acceptés, détectés sur le contenu et non sur l'extension (docs/13 D8). */
export const ALLOWED_UPLOAD_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const;
export type AllowedUploadType = (typeof ALLOWED_UPLOAD_TYPES)[number];
