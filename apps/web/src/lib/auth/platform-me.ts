import { PLATFORM_PERMISSIONS, PLATFORM_ROLES, type PlatformPermission, type PlatformRole } from '@ghmt/shared';
import { rec, str, strings } from '../domain/raw';

export interface PlatformMeView {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly role: PlatformRole;
  readonly mfaEnrolled: boolean;
  readonly mfaVerified: boolean;
  readonly permissions: readonly PlatformPermission[];
}

export const PLATFORM_HOME_PATH = '/plateforme';
export const PLATFORM_LOGIN_PATH = '/plateforme/connexion';
export const PLATFORM_MFA_PATH = '/plateforme/securite/mfa';

const KNOWN_PERMISSIONS: ReadonlySet<string> = new Set(PLATFORM_PERMISSIONS);

function isPlatformRole(value: string): value is PlatformRole {
  return (PLATFORM_ROLES as readonly string[]).includes(value);
}

/** Normalise GET /platform/auth/me ; un rôle inconnu retombe sur le rôle le moins privilégié. */
export function parsePlatformMe(raw: unknown): PlatformMeView {
  const data = rec(raw);
  if (Object.keys(data).length === 0) throw new Error('Réponse /platform/auth/me invalide');
  const email = str(data.email);
  const role = str(data.role);
  return {
    id: str(data.id),
    email,
    fullName: str(data.fullName) || email || 'Administrateur',
    role: isPlatformRole(role) ? role : 'support',
    mfaEnrolled: data.mfaEnrolled === true,
    mfaVerified: data.mfaVerified === true,
    permissions: strings(data.permissions).filter((permission): permission is PlatformPermission => KNOWN_PERMISSIONS.has(permission)),
  };
}

export function hasPlatformPermission(me: Pick<PlatformMeView, 'permissions'>, permission: PlatformPermission): boolean {
  return me.permissions.includes(permission);
}

/** Tant que la MFA n'est pas vérifiée sur la session, seule la page d'enrôlement/vérification est accessible. */
export function platformStepPath(me: Pick<PlatformMeView, 'mfaVerified'>): string | null {
  return me.mfaVerified ? null : PLATFORM_MFA_PATH;
}

export interface PlatformNavItem {
  readonly href: string;
  readonly label: string;
  readonly requires: PlatformPermission;
}

export const PLATFORM_NAV_ITEMS: readonly PlatformNavItem[] = [
  { href: PLATFORM_HOME_PATH, label: 'Tableau de bord', requires: 'dashboard:read' },
  { href: '/plateforme/etablissements', label: 'Établissements', requires: 'tenants:read' },
  { href: '/plateforme/plans', label: 'Plans', requires: 'plans:read' },
  { href: '/plateforme/factures', label: 'Factures SaaS', requires: 'invoices:read' },
];

export function visiblePlatformNav(me: Pick<PlatformMeView, 'permissions'>): readonly PlatformNavItem[] {
  return PLATFORM_NAV_ITEMS.filter((item) => hasPlatformPermission(me, item.requires));
}
