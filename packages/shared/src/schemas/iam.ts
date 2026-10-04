/**
 * Schémas Zod propres au module iam.
 * createUserSchema et createAssignmentSchema restent dans ./index.ts.
 * Pas d'import de ./index ici (dépendance circulaire à l'évaluation).
 */
import { z } from 'zod';
import { isPermissionKey } from '../permissions/catalog';

export const USER_STATUSES = ['invited', 'active', 'locked', 'disabled'] as const;

const ROLE_CODE_PATTERN = /^[a-z][a-z0-9_]{2,49}$/;
const MAX_ROLE_PERMISSIONS = 500;

const permissionCode = z.string().refine(isPermissionKey, { message: 'permission inconnue du catalogue' });
const permissionList = z
  .array(permissionCode)
  .max(MAX_ROLE_PERMISSIONS)
  .transform((codes) => [...new Set(codes)]);

/** Filtres de GET /iam/users (pagination par curseur). */
export const listUsersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(200).optional(),
  status: z.enum(USER_STATUSES).optional(),
  q: z.string().trim().min(1).max(100).optional(),
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

export const updateUserSchema = z
  .object({
    fullName: z.string().min(2).max(200).optional(),
    locale: z.enum(['fr', 'en']).optional(),
  })
  .refine((v) => v.fullName !== undefined || v.locale !== undefined, { message: 'Au moins un champ à modifier est requis' });
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const createRoleSchema = z.object({
  code: z.string().regex(ROLE_CODE_PATTERN, 'code: minuscules, chiffres et tirets bas, 3 à 50 caractères'),
  name: z.string().trim().min(2).max(100),
  description: z.string().max(500).optional(),
  permissions: permissionList,
});
export type CreateRoleInput = z.infer<typeof createRoleSchema>;

export const updateRoleSchema = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    description: z.string().max(500).optional(),
    permissions: permissionList.optional(),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined || v.permissions !== undefined, {
    message: 'Au moins un champ à modifier est requis',
  });
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
