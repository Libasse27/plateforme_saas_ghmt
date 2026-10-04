import type { createDepartmentSchema, createSiteSchema, updateDepartmentSchema, updateSiteSchema } from '@ghmt/shared';
import type { z } from 'zod';

export type CreateSiteInput = z.infer<typeof createSiteSchema>;
export type UpdateSiteInput = z.infer<typeof updateSiteSchema>;
export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>;
export type UpdateDepartmentInput = z.infer<typeof updateDepartmentSchema>;
