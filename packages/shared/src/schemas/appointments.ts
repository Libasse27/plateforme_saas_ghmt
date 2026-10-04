/**
 * Schémas Zod propres au module appointments.
 * Chaque équipe de module n'édite que son propre fichier ; les schémas communs restent dans ./index.ts.
 * (Pas d'import de ./index : ce dernier ré-exporte ce fichier, un import croisé casserait l'évaluation ESM.)
 */
import { z } from 'zod';

/** Modification partielle d'un praticien (mêmes règles que la création, tous champs optionnels). */
export const updatePractitionerSchema = z
  .object({
    fullName: z.string().min(2).max(200),
    specialty: z.string().max(100),
    departmentId: z.uuid(),
    primarySiteId: z.uuid(),
    licenseNumber: z.string().max(50),
    defaultConsultMinutes: z.number().int().min(5).max(240),
    isBookable: z.boolean(),
  })
  .partial();
export type UpdatePractitionerInput = z.infer<typeof updatePractitionerSchema>;

export const listPractitionersSchema = z.object({
  isBookable: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
});
export type ListPractitionersInput = z.infer<typeof listPractitionersSchema>;

/** Curseur de la liste des rendez-vous (la plage from/to reste validée par listAppointmentsSchema). */
export const appointmentCursorSchema = z.object({ cursor: z.string().max(200).optional() });
