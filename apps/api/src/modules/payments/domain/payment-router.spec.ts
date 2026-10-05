import { describe, expect, it } from 'vitest';
import { resolveProviderOrder } from './payment-router';

describe('routage des paiements par pays et devise', () => {
  const routes = { 'SN:XOF': ['cinetpay', 'sandbox'], XOF: ['sandbox'], '*': ['sandbox', 'cinetpay'] };

  it('préfère la clé PAYS:DEVISE, puis DEVISE, puis *', () => {
    expect(resolveProviderOrder(routes, 'SN', 'XOF')).toEqual(['cinetpay', 'sandbox']);
    expect(resolveProviderOrder(routes, 'CI', 'XOF')).toEqual(['sandbox']);
    expect(resolveProviderOrder(routes, 'CI', 'EUR')).toEqual(['sandbox', 'cinetpay']);
  });

  it('applique l’ordre par défaut (CinetPay puis sandbox) sans routage configuré', () => {
    expect(resolveProviderOrder({}, 'SN', 'XOF')).toEqual(['cinetpay', 'sandbox']);
  });

  it('élimine les doublons en conservant l’ordre', () => {
    expect(resolveProviderOrder({ '*': ['sandbox', 'sandbox', 'cinetpay'] }, 'SN', 'XOF')).toEqual(['sandbox', 'cinetpay']);
  });
});
