import { APPOINTMENT_STATUSES } from '@ghmt/shared';
import { amount, bool, items, num, rec, str, strOrNull, strings } from './raw';

/** Mappeurs tolérants de la console d'administration (docs/10 §6, §9) : endpoints existants et tableau de bord. */

export const USER_STATUS_LABELS: Readonly<Record<string, string>> = {
  invited: 'Invité',
  active: 'Actif',
  locked: 'Verrouillé',
  disabled: 'Désactivé',
  unknown: 'Inconnu',
};

export const USER_STATUS_TONES: Readonly<Record<string, 'neutral' | 'info' | 'success' | 'warning' | 'danger'>> = {
  invited: 'info',
  active: 'success',
  locked: 'warning',
  disabled: 'danger',
  unknown: 'neutral',
};

export const LOCALE_LABELS: Readonly<Record<string, string>> = { fr: 'Français', en: 'English' };

export const SCOPE_TYPE_LABELS: Readonly<Record<string, string>> = { tenant: 'Établissement', site: 'Site', department: 'Service' };

export const DEPARTMENT_KIND_LABELS: Readonly<Record<string, string>> = {
  clinical: 'Clinique',
  medico_technical: 'Médico-technique',
  administrative: 'Administratif',
  support: 'Support',
};

export const PERMISSION_ACTION_LABELS: Readonly<Record<string, string>> = {
  read: 'Lire',
  create: 'Créer',
  update: 'Modifier',
  delete: 'Supprimer',
  validate: 'Valider',
  export: 'Exporter',
  print: 'Imprimer',
};

export const PAYMENT_METHOD_LABELS = { cash: 'Espèces', mobile_money: 'Mobile Money', card: 'Carte', other: 'Autre' } as const;
export type PaymentMethodKey = keyof typeof PAYMENT_METHOD_LABELS;

// ───────── Organisation ─────────
export interface SiteAdminView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly city: string;
  readonly countryCode: string;
  readonly timezone: string;
  readonly isMain: boolean;
}

export function toSiteAdmin(raw: unknown): SiteAdminView {
  const data = rec(raw);
  return {
    id: str(data.id),
    code: str(data.code),
    name: str(data.name) || str(data.code) || 'Site',
    city: str(data.city),
    countryCode: str(data.countryCode),
    timezone: str(data.timezone),
    isMain: bool(data.isMain),
  };
}

export interface DepartmentView {
  readonly id: string;
  readonly siteId: string;
  readonly parentId: string | null;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
}

export function toDepartment(raw: unknown): DepartmentView {
  const data = rec(raw);
  return {
    id: str(data.id),
    siteId: str(data.siteId),
    parentId: strOrNull(data.parentId),
    code: str(data.code),
    name: str(data.name) || str(data.code) || 'Service',
    kind: str(data.kind, 'clinical'),
  };
}

// ───────── Utilisateurs ─────────
export interface UserSummaryView {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly status: string;
  readonly locale: string;
  readonly mustChangePassword: boolean;
  readonly lastLoginAt: string | null;
}

function userStatus(value: unknown): string {
  return typeof value === 'string' && value in USER_STATUS_LABELS && value !== 'unknown' ? value : 'unknown';
}

export function toUserSummary(raw: unknown): UserSummaryView {
  const data = rec(raw);
  return {
    id: str(data.id),
    email: str(data.email),
    fullName: str(data.fullName) || str(data.email) || 'Utilisateur',
    status: userStatus(data.status),
    locale: str(data.locale, 'fr'),
    mustChangePassword: bool(data.mustChangePassword),
    lastLoginAt: strOrNull(data.lastLoginAt),
  };
}

export interface AssignmentView {
  readonly id: string;
  readonly roleId: string;
  readonly roleCode: string;
  readonly roleName: string;
  readonly scopeType: string;
  readonly scopeId: string | null;
  readonly validFrom: string;
  readonly validUntil: string | null;
}

export function toAssignment(raw: unknown): AssignmentView {
  const data = rec(raw);
  return {
    id: str(data.id),
    roleId: str(data.roleId),
    roleCode: str(data.roleCode),
    roleName: str(data.roleName) || 'Rôle',
    scopeType: str(data.scopeType, 'tenant'),
    scopeId: strOrNull(data.scopeId),
    validFrom: str(data.validFrom),
    validUntil: strOrNull(data.validUntil),
  };
}

export interface UserDetailView extends UserSummaryView {
  readonly assignments: readonly AssignmentView[];
}

export function toUserDetail(raw: unknown): UserDetailView {
  return { ...toUserSummary(raw), assignments: items(rec(raw).assignments, toAssignment) };
}

interface Named {
  readonly id: string;
  readonly name: string;
}

/** Texte de portée d'une affectation (établissement, site ou service nommés). */
export function scopeLabel(
  assignment: Pick<AssignmentView, 'scopeType' | 'scopeId'>,
  sites: readonly Named[],
  departments: readonly Named[],
): string {
  if (assignment.scopeType === 'site') return `Site : ${sites.find((s) => s.id === assignment.scopeId)?.name ?? 'inconnu'}`;
  if (assignment.scopeType === 'department') return `Service : ${departments.find((d) => d.id === assignment.scopeId)?.name ?? 'inconnu'}`;
  return SCOPE_TYPE_LABELS.tenant as string;
}

export type UserActionKind = 'resend' | 'disable' | 'enable' | 'unlock' | 'revokeSessions';

export interface UserActionRights {
  readonly update: boolean;
  readonly create: boolean;
  readonly revokeSessions: boolean;
}

/** Boutons proposés selon le statut et les permissions (l'API reste l'arbitre). */
export function availableUserActions(status: string, rights: UserActionRights): readonly UserActionKind[] {
  const byStatus: Readonly<Record<string, readonly UserActionKind[]>> = {
    invited: ['resend', 'disable'],
    active: ['disable', 'revokeSessions'],
    locked: ['unlock', 'disable', 'revokeSessions'],
    disabled: ['enable'],
  };
  const allowed: Readonly<Record<UserActionKind, boolean>> = {
    resend: rights.create,
    disable: rights.update,
    enable: rights.update,
    unlock: rights.update,
    revokeSessions: rights.revokeSessions,
  };
  return (byStatus[status] ?? []).filter((kind) => allowed[kind]);
}

// ───────── Rôles et permissions ─────────
export interface RoleSummaryView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly isSystem: boolean;
  readonly mfaRequired: boolean;
  readonly permissionCount: number;
}

export function toRoleSummary(raw: unknown): RoleSummaryView {
  const data = rec(raw);
  return {
    id: str(data.id),
    code: str(data.code),
    name: str(data.name) || 'Rôle',
    description: str(data.description),
    isSystem: data.isSystem !== false,
    mfaRequired: bool(data.mfaRequired),
    permissionCount: num(data.permissionCount, strings(data.permissions).length),
  };
}

export interface RoleDetailView extends RoleSummaryView {
  readonly permissions: readonly string[];
}

export function toRoleDetail(raw: unknown): RoleDetailView {
  return { ...toRoleSummary(raw), permissions: strings(rec(raw).permissions) };
}

export interface PermissionEntry {
  readonly code: string;
  readonly resource: string;
  readonly action: string;
  readonly isSensitive: boolean;
}

export interface PermissionGroup {
  readonly module: string;
  readonly name: string;
  readonly permissions: readonly PermissionEntry[];
}

function toPermissionEntry(raw: unknown): PermissionEntry | null {
  const data = rec(raw);
  const code = str(data.code);
  return code ? { code, resource: str(data.resource), action: str(data.action), isSensitive: bool(data.isSensitive) } : null;
}

export function toPermissionGroups(raw: unknown): PermissionGroup[] {
  return items(raw, (entry): PermissionGroup => {
    const data = rec(entry);
    return {
      module: str(data.module),
      name: str(data.name) || str(data.module),
      permissions: items(data.permissions, toPermissionEntry).filter((p): p is PermissionEntry => p !== null),
    };
  });
}

export interface MatrixResource {
  readonly resource: string;
  readonly cells: Readonly<Record<string, PermissionEntry | undefined>>;
}

export interface MatrixModule {
  readonly module: string;
  readonly name: string;
  readonly actions: readonly string[];
  readonly resources: readonly MatrixResource[];
}

const ACTION_ORDER = Object.keys(PERMISSION_ACTION_LABELS);

/** Modules x ressources x actions, dans l'ordre du catalogue (actions triées par ordre canonique). */
export function buildPermissionMatrix(groups: readonly PermissionGroup[]): MatrixModule[] {
  return groups.map((group) => {
    const actions = [...new Set(group.permissions.map((p) => p.action))].sort((a, b) => ACTION_ORDER.indexOf(a) - ACTION_ORDER.indexOf(b));
    const resources = [...new Set(group.permissions.map((p) => p.resource))].map(
      (resource): MatrixResource => ({
        resource,
        cells: Object.fromEntries(group.permissions.filter((p) => p.resource === resource).map((p) => [p.action, p])),
      }),
    );
    return { module: group.module, name: group.name, actions, resources };
  });
}

// ───────── Praticiens ─────────
export interface PractitionerAdminView {
  readonly id: string;
  readonly userId: string | null;
  readonly fullName: string;
  readonly specialty: string;
  readonly departmentId: string | null;
  readonly primarySiteId: string | null;
  readonly licenseNumber: string;
  readonly defaultConsultMinutes: number;
  readonly isBookable: boolean;
}

const DEFAULT_CONSULT_MINUTES = 20;

export function toPractitionerAdmin(raw: unknown): PractitionerAdminView {
  const data = rec(raw);
  return {
    id: str(data.id),
    userId: strOrNull(data.userId),
    fullName: str(data.fullName) || 'Praticien',
    specialty: str(data.specialty),
    departmentId: strOrNull(data.departmentId),
    primarySiteId: strOrNull(data.primarySiteId),
    licenseNumber: str(data.licenseNumber),
    defaultConsultMinutes: num(data.defaultConsultMinutes, DEFAULT_CONSULT_MINUTES),
    isBookable: bool(data.isBookable),
  };
}

// ───────── Tableau de bord ─────────
export interface DashboardView {
  readonly date: string;
  readonly timezone: string;
  readonly generatedAt: string;
  readonly siteId: string | null;
  readonly patients: { readonly total: number; readonly registeredToday: number } | null;
  readonly appointments: { readonly total: number; readonly byStatus: Readonly<Record<string, number>> } | null;
  readonly revenue: { readonly currency: string; readonly total: string; readonly byMethod: Readonly<Record<PaymentMethodKey, string>> } | null;
  readonly cashSessions: {
    readonly openCount: number;
    readonly items: readonly { readonly id: string; readonly registerCode: string; readonly siteId: string | null; readonly openedAt: string; readonly openedBy: string }[];
  } | null;
}

function section<T>(value: unknown, read: (data: Record<string, unknown>) => T): T | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? read(value as Record<string, unknown>) : null;
}

export function toDashboard(raw: unknown): DashboardView {
  const data = rec(raw);
  return {
    date: str(data.date),
    timezone: str(data.timezone),
    generatedAt: str(data.generatedAt),
    siteId: strOrNull(data.siteId),
    patients: section(data.patients, (p) => ({ total: num(p.total), registeredToday: num(p.registeredToday) })),
    appointments: section(data.appointments, (a) => ({
      total: num(a.total),
      byStatus: Object.fromEntries(APPOINTMENT_STATUSES.map((status) => [status, num(rec(a.byStatus)[status])])),
    })),
    revenue: section(data.revenue, (r) => ({
      currency: str(r.currency, 'XOF'),
      total: amount(r.total),
      byMethod: {
        cash: amount(rec(r.byMethod).cash),
        mobile_money: amount(rec(r.byMethod).mobile_money),
        card: amount(rec(r.byMethod).card),
        other: amount(rec(r.byMethod).other),
      },
    })),
    cashSessions: section(data.cashSessions, (c) => ({
      openCount: num(c.openCount),
      items: items(c.items, (entry) => {
        const item = rec(entry);
        return {
          id: str(item.id),
          registerCode: str(item.registerCode),
          siteId: strOrNull(item.siteId),
          openedAt: str(item.openedAt),
          openedBy: str(rec(item.openedBy).fullName) || 'Inconnu',
        };
      }),
    })),
  };
}

/** Première valeur de chaque paramètre d'URL (Next fournit des tableaux pour les paramètres répétés). */
export function firstValues(raw: Readonly<Record<string, string | string[] | undefined>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined) result[key] = first;
  }
  return result;
}

export function siteOptionLabel(site: { readonly name: string; readonly city: string }): string {
  return site.city ? `${site.name} (${site.city})` : site.name;
}
