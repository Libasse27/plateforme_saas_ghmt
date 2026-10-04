import { describe, expect, it } from 'vitest';
import { visibleNav } from './nav';

const hrefs = (me: { permissions: string[]; modules: string[] }) => visibleNav(me).map((item) => item.href);

describe('menus de facturation conditionnés par permissions et modules', () => {
  it('masque factures, tarifs, caisse et abonnement sans droit', () => {
    expect(hrefs({ permissions: ['patients:patient:read'], modules: ['patients'] })).toEqual(['/', '/patients', '/securite/mfa', '/securite/mot-de-passe']);
  });
  it('affiche chaque entrée selon sa permission ET son module souscrit', () => {
    const all = hrefs({
      permissions: ['billing:invoice:read', 'billing:price_list:read', 'cashier:cash_session:read', 'settings:establishment:read'],
      modules: ['billing', 'cashier'],
    });
    expect(all).toEqual(['/', '/facturation/factures', '/facturation/tarifs', '/caisse', '/abonnement', '/securite/mfa', '/securite/mot-de-passe']);
  });
  it('masque une entrée dont le module n\'est pas souscrit', () => {
    expect(hrefs({ permissions: ['billing:invoice:read', 'cashier:cash_session:read'], modules: ['billing'] })).not.toContain('/caisse');
  });
  it('l\'abonnement dépend de la seule permission settings:establishment:read', () => {
    expect(hrefs({ permissions: ['settings:establishment:read'], modules: [] })).toContain('/abonnement');
    expect(hrefs({ permissions: [], modules: ['settings'] })).not.toContain('/abonnement');
  });
});
