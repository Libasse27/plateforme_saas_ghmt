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
  readonly lastSeenAt: Date | null;
  readonly createdAt: Date;
  readonly credential?: { readonly mustChangePassword: boolean } | null;
  /** Facteurs TOTP actifs (au plus un). */
  readonly mfaFactors?: readonly { readonly id: string }[];
  readonly assignments?: readonly AssignmentRow[];
}

/** Données hors ligne utilisateur : administrateur principal (badge `isOwner`) et délai progressif de connexion en cours. */
export interface UserViewContext {
  readonly ownerUserId?: string | null;
  readonly loginDelayed?: boolean;
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
  lastSeenAt: true,
  createdAt: true,
  credential: { select: { mustChangePassword: true } },
  mfaFactors: { where: { kind: 'totp', activatedAt: { not: null } }, select: { id: true } },
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

/** `isOwner` (docs/11 D9), `mfaEnrolled` et `loginDelayed` (docs/11 §14.1). */
export function toUserDto(row: UserRow, context: UserViewContext = {}) {
  const ownerUserId = context.ownerUserId ?? null;
  return {
    id: row.id,
    email: row.email,
    fullName: row.fullName,
    status: row.status,
    locale: row.locale,
    mustChangePassword: row.credential?.mustChangePassword ?? false,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    isOwner: ownerUserId !== null && row.id === ownerUserId,
    mfaEnrolled: (row.mfaFactors?.length ?? 0) > 0,
    loginDelayed: context.loginDelayed ?? false,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toUserDetailDto(row: UserRow, context: UserViewContext = {}) {
  return { ...toUserDto(row, context), assignments: (row.assignments ?? []).map(toAssignmentDto) };
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
