import { patternMatches, type ModuleCode, type PermissionKey } from '@ghmt/shared';

export interface Me {
  readonly user: { readonly id: string; readonly fullName: string; readonly email: string; readonly mustChangePassword: boolean };
  readonly tenant: { readonly id: string; readonly slug: string; readonly name: string;
    readonly timezone: string;
    readonly countryCode: string;
    readonly baseCurrency: string;
  };
  readonly permissions: readonly string[];
  readonly modules: readonly string[];
  readonly mfa: { readonly enrolled: boolean; readonly verified: boolean; readonly required: boolean };
}

export const DEFAULT_TIMEZONE = 'Africa/Dakar';

type UnknownRecord = Record<string, unknown>;

function rec(value: unknown): UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as UnknownRecord) : {};
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function stringList(value: unknown, pick?: (entry: UnknownRecord) => unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): string[] => {
    if (typeof entry === 'string') return [entry];
    const picked = pick?.(rec(entry));
    return typeof picked === 'string' ? [picked] : [];
  });
}

/** Normalise la réponse de GET /auth/me, en tolérant les variantes de forme (modules en chaînes ou objets). */
export function parseMe(raw: unknown): Me {
  const data = rec(raw);
  if (Object.keys(data).length === 0) throw new Error('Réponse /auth/me invalide');
  const user = rec(data.user);
  const tenant = rec(data.tenant);
  const mfa = rec(data.mfa);
  const email = str(user.email);
  return {
    user: { id: str(user.id), fullName: str(user.fullName) || email || 'Utilisateur', email, mustChangePassword: user.mustChangePassword === true },
    tenant: {
      id: str(tenant.id),
      slug: str(tenant.slug),
      name: str(tenant.tradeName) || str(tenant.name) || str(tenant.legalName) || str(tenant.slug) || 'Établissement',
      timezone: str(tenant.timezone) || DEFAULT_TIMEZONE,
      countryCode: str(tenant.countryCode).toUpperCase(),
      baseCurrency: str(tenant.baseCurrency).toUpperCase(),
    },
    permissions: stringList(data.permissions),
    modules: stringList(data.modules, (m) => m.code ?? m.moduleCode),
    mfa: {
      enrolled: mfa.enrolled === true,
      verified: mfa.verified === true,
      required: mfa.required === true,
    },
  };
}

export function hasPermission(me: Pick<Me, 'permissions'>, permission: PermissionKey): boolean {
  return me.permissions.some((pattern) => patternMatches(pattern, permission));
}

export function hasModule(me: Pick<Me, 'modules'>, moduleCode: ModuleCode): boolean {
  return me.modules.includes(moduleCode);
}

/** Module souscrit ET permission accordée. */
export function canUse(me: Pick<Me, 'permissions' | 'modules'>, moduleCode: ModuleCode, permission: PermissionKey): boolean {
  return hasModule(me, moduleCode) && hasPermission(me, permission);
}

/** docs/04 : MFA imposée mais non vérifiée sur la session → page d'enrôlement. */
export function needsMfaStep(me: Pick<Me, 'mfa'>): boolean {
  return me.mfa.required && !me.mfa.verified;
}

export const PASSWORD_CHANGE_PATH = '/securite/mot-de-passe';
export const MFA_PATH = '/securite/mfa';

export interface StepOptions {
  readonly allowMfaPending?: boolean;
  readonly allowPasswordChange?: boolean;
}

/** Étape obligatoire avant l'accès à la console : changement de mot de passe (C7) puis MFA. */
export function requiredStepPath(me: Pick<Me, 'mfa'> & { readonly user: Pick<Me['user'], 'mustChangePassword'> }, options: StepOptions = {}): string | null {
  if (me.user.mustChangePassword && !options.allowPasswordChange) return PASSWORD_CHANGE_PATH;
  if (needsMfaStep(me) && !options.allowMfaPending) return MFA_PATH;
  return null;
}
