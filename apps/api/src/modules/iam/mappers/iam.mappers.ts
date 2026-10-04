/** Sorties explicites : jamais de password_hash ni de colonne interne. */

export interface AssignmentRow {
  readonly id: string;
  readonly roleId: string;
  readonly scopeType: string;
  readonly scopeId: string | null;
  readonly validFrom: Date;
  readonly validUntil: Date | null;
  readonly createdAt: Date;
  readonly role: { readonly code: string; readonly name: string };
}

export interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly status: string;
  readonly locale: string;
  readonly lastLoginAt: Date | null;
  readonly createdAt: Date;
  readonly credential?: { readonly mustChangePassword: boolean } | null;
  readonly assignments?: readonly AssignmentRow[];
}

export const ASSIGNMENT_SELECT = {
  id: true,
  roleId: true,
  scopeType: true,
  scopeId: true,
  validFrom: true,
  validUntil: true,
  createdAt: true,
  role: { select: { code: true, name: true } },
} as const;

export const USER_SELECT = {
  id: true,
  email: true,
  fullName: true,
  status: true,
  locale: true,
  lastLoginAt: true,
  createdAt: true,
  credential: { select: { mustChangePassword: true } },
} as const;

export function toAssignmentDto(row: AssignmentRow) {
  return {
    id: row.id,
    roleId: row.roleId,
    roleCode: row.role.code,
    roleName: row.role.name,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    validFrom: row.validFrom.toISOString(),
    validUntil: row.validUntil?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toUserDto(row: UserRow) {
  return {
    id: row.id,
    email: row.email,
    fullName: row.fullName,
    status: row.status,
    locale: row.locale,
    mustChangePassword: row.credential?.mustChangePassword ?? false,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toUserDetailDto(row: UserRow) {
  return { ...toUserDto(row), assignments: (row.assignments ?? []).map(toAssignmentDto) };
}

export interface RoleRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly isSystem: boolean;
  readonly mfaRequired: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly permissions?: readonly { readonly permissionCode: string }[];
}

export const ROLE_SELECT = {
  id: true,
  code: true,
  name: true,
  description: true,
  isSystem: true,
  mfaRequired: true,
  createdAt: true,
  updatedAt: true,
  permissions: { select: { permissionCode: true }, orderBy: { permissionCode: 'asc' } },
} as const;

export function toRoleDto(row: RoleRow) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    isSystem: row.isSystem,
    mfaRequired: row.mfaRequired,
    permissionCount: row.permissions?.length ?? 0,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toRoleDetailDto(row: RoleRow) {
  return { ...toRoleDto(row), permissions: (row.permissions ?? []).map((p) => p.permissionCode) };
}
