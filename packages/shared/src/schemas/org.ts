/**
 * Schémas Zod propres au module org.
 * Les schémas de création/modification (createSiteSchema, createDepartmentSchema…) restent dans ./index.ts.
 */
import { z } from 'zod';

/** Filtres de GET /org/departments. */
export const listDepartmentsQuerySchema = z.object({
  siteId: z.uuid().optional(),
});
export type ListDepartmentsQuery = z.infer<typeof listDepartmentsQuerySchema>;
