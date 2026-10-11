import { describe, expect, it } from 'vitest';
import { CLINICAL_MFA_LABELS, isOwnerOf, toSecurityPolicy, toTrustedNetwork } from './security';

describe('toTrustedNetwork', () => {
  it('lit une plage complète', () => {
    expect(
      toTrustedNetwork({ id: 'n1', cidr: '203.0.113.0/24', label: 'Siège', siteId: 's1', createdAt: '2026-10-05T08:00:00.000Z', createdBy: { id: 'u1', fullName: 'Awa Diop' } }),
    ).toEqual({ id: 'n1', cidr: '203.0.113.0/24', label: 'Siège', createdAt: '2026-10-05T08:00:00.000Z', createdBy: { id: 'u1', fullName: 'Awa Diop' } });
  });

  it('tolère les champs absents ou mal typés', () => {
    expect(toTrustedNetwork({})).toEqual({ id: '', cidr: '', label: '', createdAt: '', createdBy: null });
    expect(toTrustedNetwork(null).createdBy).toBeNull();
    expect(toTrustedNetwork({ createdBy: { id: 4 } }).createdBy).toBeNull();
    expect(toTrustedNetwork({ createdBy: { id: 'u1' } }).createdBy).toEqual({ id: 'u1', fullName: 'Utilisateur' });
  });
});

describe('toSecurityPolicy', () => {
  it('lit la politique, les plages, l\'adresse courante et le principal', () => {
    const policy = toSecurityPolicy({
      clinicalMfa: 'always',
      trustedNetworks: [{ id: 'n1', cidr: '10.0.0.0/16', label: 'LAN' }],
      requestIp: '203.0.113.5',
      requestIpTrusted: true,
      owner: { id: 'u1', fullName: 'Awa Diop' },
      updatedAt: '2026-10-05T08:00:00.000Z',
    });
    expect(policy.clinicalMfa).toBe('always');
    expect(policy.trustedNetworks).toHaveLength(1);
    expect(policy.requestIp).toBe('203.0.113.5');
    expect(policy.requestIpTrusted).toBe(true);
    expect(policy.owner).toEqual({ id: 'u1', fullName: 'Awa Diop' });
    expect(policy.updatedAt).toBe('2026-10-05T08:00:00.000Z');
  });

  it('retombe sur les défauts du contrat pour une réponse vide ou inattendue', () => {
    for (const raw of [undefined, null, {}, 'x', []]) {
      expect(toSecurityPolicy(raw)).toEqual({ clinicalMfa: 'off_network', trustedNetworks: [], requestIp: null, requestIpTrusted: false, owner: null, updatedAt: null, canManage: null, clinicalUsersWithoutMfa: 0 });
    }
  });

  it('refuse un mode inconnu (retombe sur off_network)', () => {
    expect(toSecurityPolicy({ clinicalMfa: 'disabled' }).clinicalMfa).toBe('off_network');
  });

  it('lit canManage et clinicalUsersWithoutMfa (docs/11 §14.1)', () => {
    expect(toSecurityPolicy({ canManage: true, clinicalUsersWithoutMfa: 4 })).toMatchObject({ canManage: true, clinicalUsersWithoutMfa: 4 });
    expect(toSecurityPolicy({ canManage: false, clinicalUsersWithoutMfa: 0 })).toMatchObject({ canManage: false, clinicalUsersWithoutMfa: 0 });
  });

  it('champs absents (API pas encore à jour) : canManage inconnu (null) et aucun soignant sans second facteur', () => {
    expect(toSecurityPolicy({})).toMatchObject({ canManage: null, clinicalUsersWithoutMfa: 0 });
    expect(toSecurityPolicy({ canManage: 'oui', clinicalUsersWithoutMfa: -3 })).toMatchObject({ canManage: null, clinicalUsersWithoutMfa: 0 });
    expect(toSecurityPolicy({ clinicalUsersWithoutMfa: 2.7 }).clinicalUsersWithoutMfa).toBe(0);
  });

  it('ignore un principal sans identifiant', () => {
    expect(toSecurityPolicy({ owner: { fullName: 'X' } }).owner).toBeNull();
  });
});

describe('isOwnerOf et libellés', () => {
  it('compare l\'identifiant au principal', () => {
    const policy = toSecurityPolicy({ owner: { id: 'u1', fullName: 'A' } });
    expect(isOwnerOf(policy, 'u1')).toBe(true);
    expect(isOwnerOf(policy, 'u2')).toBe(false);
    expect(isOwnerOf(toSecurityPolicy({}), 'u1')).toBe(false);
    expect(isOwnerOf(null, 'u1')).toBe(false);
  });

  it('libellés français des deux modes', () => {
    expect(Object.keys(CLINICAL_MFA_LABELS)).toEqual(['off_network', 'always']);
  });
});
