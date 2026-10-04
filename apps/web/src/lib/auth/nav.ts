import type { ModuleCode, PermissionKey } from '@ghmt/shared';
import { canUse, hasPermission, type Me } from './me';

export interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly requires?: { readonly module?: ModuleCode; readonly permission: PermissionKey };
}

export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/', label: 'Tableau de bord' },
  { href: '/patients', label: 'Patients', requires: { module: 'patients', permission: 'patients:patient:read' } },
  { href: '/rendez-vous', label: 'Rendez-vous', requires: { module: 'appointments', permission: 'appointments:appointment:read' } },
  { href: '/facturation/factures', label: 'Factures', requires: { module: 'billing', permission: 'billing:invoice:read' } },
  { href: '/facturation/tarifs', label: 'Tarifs', requires: { module: 'billing', permission: 'billing:price_list:read' } },
  { href: '/caisse', label: 'Caisse', requires: { module: 'cashier', permission: 'cashier:cash_session:read' } },
  { href: '/abonnement', label: 'Abonnement', requires: { permission: 'settings:establishment:read' } },
  { href: '/securite/mfa', label: 'Sécurité (MFA)' },
  { href: '/securite/mot-de-passe', label: 'Mot de passe' },
];

export function visibleNav(me: Pick<Me, 'permissions' | 'modules'>): readonly NavItem[] {
  return NAV_ITEMS.filter((item) => {
    const { requires } = item;
    if (!requires) return true;
    return requires.module ? canUse(me, requires.module, requires.permission) : hasPermission(me, requires.permission);
  });
}

export { isActivePath } from './active-path';
