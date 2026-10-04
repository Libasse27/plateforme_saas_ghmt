import type { ModuleCode, PermissionKey } from '@ghmt/shared';
import { canUse, type Me } from './me';

export interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly requires?: { readonly module: ModuleCode; readonly permission: PermissionKey };
}

export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/', label: 'Tableau de bord' },
  { href: '/patients', label: 'Patients', requires: { module: 'patients', permission: 'patients:patient:read' } },
  { href: '/rendez-vous', label: 'Rendez-vous', requires: { module: 'appointments', permission: 'appointments:appointment:read' } },
  { href: '/securite/mfa', label: 'Sécurité (MFA)' },
  { href: '/securite/mot-de-passe', label: 'Mot de passe' },
];

export function visibleNav(me: Pick<Me, 'permissions' | 'modules'>): readonly NavItem[] {
  return NAV_ITEMS.filter((item) => !item.requires || canUse(me, item.requires.module, item.requires.permission));
}

export { isActivePath } from './active-path';
