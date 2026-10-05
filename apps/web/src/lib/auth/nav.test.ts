import { describe, expect, it } from 'vitest';
import { visibleNav } from './nav';

const groupOf = (me: { permissions: string[]; modules: string[] }) => visibleNav(me).filter((item) => item.group === 'administration').map((item) => item.href);

const hrefs = (me: { permissions: string[]; modules: string[] }) => visibleNav(me).map((item) => item.href);

describe('menus de facturation conditionnés par permissions et modules', () => {
  it('masque factures, tarifs, caisse et abonnement sans droit', () => {
    expect(hrefs({ permissions: ['patients:patient:read'], modules: ['patients'] })).toEqual(['/', '/patients', '/notifications', '/securite/mfa', '/securite/mot-de-passe']);
  });
  it('affiche chaque entrée selon sa permission ET son module souscrit', () => {
    const all = hrefs({
      permissions: ['billing:invoice:read', 'billing:price_list:read', 'cashier:cash_session:read', 'settings:establishment:read'],
      modules: ['billing', 'cashier'],
    });
    expect(all).toEqual(['/', '/facturation/factures', '/facturation/tarifs', '/caisse', '/abonnement', '/notifications', '/securite/mfa', '/securite/mot-de-passe']);
  });
  it('masque une entrée dont le module n\'est pas souscrit', () => {
    expect(hrefs({ permissions: ['billing:invoice:read', 'cashier:cash_session:read'], modules: ['billing'] })).not.toContain('/caisse');
  });
  it('l\'abonnement dépend de la seule permission settings:establishment:read', () => {
    expect(hrefs({ permissions: ['settings:establishment:read'], modules: [] })).toContain('/abonnement');
    expect(hrefs({ permissions: [], modules: ['settings'] })).not.toContain('/abonnement');
  });
});

describe('groupe Administration', () => {
  it('est absent sans permission d\'administration', () => {
    expect(groupOf({ permissions: ['patients:patient:read'], modules: ['patients'] })).toEqual([]);
  });
  it('chaque entrée dépend de sa permission', () => {
    expect(groupOf({ permissions: ['reports:dashboard:read'], modules: [] })).toEqual(['/administration']);
    expect(groupOf({ permissions: ['org:site:read'], modules: [] })).toEqual(['/administration/organisation']);
    expect(groupOf({ permissions: ['iam:user:read'], modules: [] })).toEqual(['/administration/utilisateurs']);
    expect(groupOf({ permissions: ['iam:role:read'], modules: [] })).toEqual(['/administration/roles']);
    expect(groupOf({ permissions: ['audit:log:read'], modules: [] })).toEqual(['/administration/journal']);
  });
  it('praticiens : module appointments ET agenda', () => {
    expect(groupOf({ permissions: ['appointments:agenda:read'], modules: [] })).toEqual([]);
    expect(groupOf({ permissions: [], modules: ['appointments'] })).toEqual([]);
    expect(groupOf({ permissions: ['appointments:agenda:read'], modules: ['appointments'] })).toEqual(['/administration/praticiens']);
  });
  it('un administrateur (motifs génériques) voit tout le groupe dans l\'ordre', () => {
    expect(groupOf({ permissions: ['iam:*:*', 'org:*:*', 'audit:*:*', 'reports:*:*', 'appointments:*:*'], modules: ['appointments'] })).toEqual([
      '/administration', '/administration/organisation', '/administration/utilisateurs', '/administration/roles', '/administration/praticiens', '/administration/journal',
    ]);
  });
  it('les notifications sont ouvertes à tout utilisateur', () => {
    expect(hrefs({ permissions: [], modules: [] })).toContain('/notifications');
  });
});
