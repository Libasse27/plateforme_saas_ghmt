/**
 * Catalogue de permissions GHMT — source unique (docs/04-securite-rbac-audit.md §3.2).
 * Format : `module:ressource:action`.
 */

export const ACTIONS = ['read', 'create', 'update', 'delete', 'validate', 'export', 'print'] as const;
export type Action = (typeof ACTIONS)[number];

type ResourceMap = Readonly<Record<string, readonly Action[]>>;

export const PERMISSION_CATALOG = {
  iam: {
    user: ['read', 'create', 'update', 'delete', 'export'],
    role: ['read', 'create', 'update', 'delete'],
    assignment: ['read', 'create', 'delete'],
    session: ['read', 'delete'],
    invitation: ['read', 'create', 'delete'],
    policy: ['read', 'update'],
  },
  org: {
    group: ['read', 'create', 'update', 'delete'],
    establishment: ['read', 'create', 'update', 'delete'],
    site: ['read', 'create', 'update', 'delete'],
    service: ['read', 'create', 'update', 'delete'],
  },
  patients: {
    patient: ['read', 'create', 'update', 'delete', 'export', 'print'],
    identity_doc: ['read', 'create'],
    consent: ['read', 'create', 'update'],
    merge: ['validate'],
  },
  appointments: {
    appointment: ['read', 'create', 'update', 'delete', 'print'],
    agenda: ['read', 'update'],
  },
  consultations: {
    consultation: ['read', 'create', 'update', 'validate', 'print'],
    diagnosis: ['read', 'create', 'update'],
    prescription: ['read', 'create', 'update', 'validate', 'print'],
    medical_record: ['read', 'export', 'print'],
  },
  nursing: {
    care_plan: ['read', 'create', 'update', 'validate'],
    vitals: ['read', 'create', 'update'],
    administration: ['read', 'create', 'validate'],
  },
  maternity: {
    pregnancy_file: ['read', 'create', 'update', 'validate'],
    delivery: ['read', 'create', 'update', 'validate'],
    newborn: ['read', 'create', 'update'],
  },
  inpatient: {
    admission: ['read', 'create', 'update', 'validate'],
    bed: ['read', 'update'],
    discharge: ['create', 'validate', 'print'],
  },
  pharmacy: {
    dispensation: ['read', 'create', 'validate', 'print'],
    drug: ['read', 'create', 'update', 'delete'],
    stock_movement: ['read', 'create'],
    order: ['read', 'create', 'validate'],
  },
  laboratory: {
    order: ['read', 'create'],
    sample: ['read', 'create', 'update'],
    result: ['read', 'create', 'update', 'validate', 'print', 'export'],
  },
  imaging: {
    order: ['read', 'create'],
    report: ['read', 'create', 'update', 'validate', 'print'],
    image: ['read', 'create'],
  },
  billing: {
    invoice: ['read', 'create', 'update', 'delete', 'validate', 'print', 'export'],
    price_list: ['read', 'update'],
    insurance_claim: ['read', 'create', 'validate', 'export'],
  },
  cashier: {
    payment: ['read', 'create', 'validate', 'print'],
    cash_session: ['read', 'create', 'validate'],
    refund: ['create', 'validate'],
  },
  accounting: {
    entry: ['read', 'create', 'update', 'validate', 'export'],
    period: ['validate'],
    report: ['read', 'export', 'print'],
  },
  hr: {
    employee: ['read', 'create', 'update', 'delete', 'export'],
    payroll: ['read', 'create', 'validate', 'print', 'export'],
    leave: ['read', 'create', 'validate'],
    schedule: ['read', 'update'],
  },
  inventory: {
    item: ['read', 'create', 'update', 'delete'],
    movement: ['read', 'create', 'validate'],
    purchase_order: ['read', 'create', 'validate'],
    inventory_count: ['create', 'validate'],
  },
  reports: {
    dashboard: ['read'],
    report: ['read', 'export', 'print'],
    statistics: ['read', 'export'],
  },
  settings: {
    establishment: ['read', 'update'],
    notification_template: ['read', 'update'],
    integration: ['read', 'update'],
    module: ['read'],
    /** Journal des envois de notifications (docs/10 §4). */
    notification_log: ['read'],
  },
  audit: {
    log: ['read', 'export'],
    alert: ['read', 'update'],
    access_report: ['read', 'export'],
  },
  breakglass: {
    access: ['create'],
  },
} as const satisfies Readonly<Record<string, ResourceMap>>;

type Catalog = typeof PERMISSION_CATALOG;
export type ModuleCode = keyof Catalog;

/** Union littérale de toutes les permissions valides, ex. `'patients:patient:read'`. */
export type PermissionKey = {
  [M in ModuleCode]: {
    [R in keyof Catalog[M] & string]: `${M}:${R}:${Catalog[M][R] extends readonly (infer A)[] ? A & string : never}`;
  }[keyof Catalog[M] & string];
}[ModuleCode];

export interface PermissionDefinition {
  readonly code: PermissionKey;
  readonly moduleCode: ModuleCode;
  readonly resource: string;
  readonly action: Action;
  /** Lecture de dossier clinique, export, impression, validation, suppression : toujours auditées. */
  readonly isSensitive: boolean;
}

const SENSITIVE_ACTIONS: ReadonlySet<Action> = new Set(['export', 'print', 'validate', 'delete']);
const SENSITIVE_READ_MODULES: ReadonlySet<string> = new Set([
  'patients',
  'consultations',
  'nursing',
  'maternity',
  'inpatient',
  'laboratory',
  'imaging',
]);

export const ALL_PERMISSIONS: readonly PermissionDefinition[] = Object.freeze(
  Object.entries(PERMISSION_CATALOG).flatMap(([moduleCode, resources]) =>
    Object.entries(resources as ResourceMap).flatMap(([resource, actions]) =>
      actions.map((action) =>
        Object.freeze({
          code: `${moduleCode}:${resource}:${action}` as PermissionKey,
          moduleCode: moduleCode as ModuleCode,
          resource,
          action,
          isSensitive:
            SENSITIVE_ACTIONS.has(action) || (action === 'read' && SENSITIVE_READ_MODULES.has(moduleCode)),
        }),
      ),
    ),
  ),
);

const PERMISSION_CODES: ReadonlySet<string> = new Set(ALL_PERMISSIONS.map((p) => p.code));

export function isPermissionKey(value: string): value is PermissionKey {
  return PERMISSION_CODES.has(value);
}

export function moduleOf(permission: PermissionKey): ModuleCode {
  return permission.split(':')[0] as ModuleCode;
}

/**
 * Teste si un motif de rôle (jokers `*` autorisés par segment) couvre une permission précise.
 * Les jokers ne sont admis que dans les définitions de rôles, jamais dans `@RequirePermission`.
 */
export function patternMatches(pattern: string, permission: PermissionKey): boolean {
  const p = pattern.split(':');
  const k = permission.split(':');
  if (p.length !== 3) return false;
  return p.every((segment, i) => segment === '*' || segment === k[i]);
}

/** Développe une liste de motifs en permissions concrètes du catalogue (dédupliquées, triées). */
export function expandPatterns(patterns: readonly string[]): PermissionKey[] {
  const matched = ALL_PERMISSIONS.filter((def) => patterns.some((pattern) => patternMatches(pattern, def.code)));
  return [...new Set(matched.map((def) => def.code))].sort();
}
