import { describe, expect, it } from 'vitest';
import {
  currentNetworkCidr,
  forgotPasswordForm,
  isOpaqueLinkToken,
  parseCidr,
  reasonForm,
  removeNetworkForm,
  resendVerificationForm,
  resetPasswordForm,
  safeTenantSlug,
  transferOwnerForm,
  trustedNetworkForm,
  policyForm,
  validateCidr,
} from './security-forms';

const UUID = '0190a3b2-7c11-7a55-9e0f-3a1b2c3d4e5f';
const TOKEN = `${UUID}.abcdefghijklmnopqrstuvwxyz0123456789_-ABCDEF`;

describe('parseCidr', () => {
  it('lit une plage IPv4 et normalise la forme réseau (bits d\'hôte effacés)', () => {
    expect(parseCidr('203.0.113.0/24')).toEqual({ family: 4, prefix: 24, network: '203.0.113.0' });
    expect(parseCidr(' 203.0.113.77/24 ')).toEqual({ family: 4, prefix: 24, network: '203.0.113.0' });
    expect(parseCidr('10.255.255.255/16')).toEqual({ family: 4, prefix: 16, network: '10.255.0.0' });
    expect(parseCidr('198.51.100.7/32')).toEqual({ family: 4, prefix: 32, network: '198.51.100.7' });
    expect(parseCidr('198.51.100.7/21')?.network).toBe('198.51.96.0');
  });

  it('lit une plage IPv6, la compresse et la met en minuscules', () => {
    expect(parseCidr('2001:0DB8:0000:0000:0000:0000:0000:0000/32')).toEqual({ family: 6, prefix: 32, network: '2001:db8::' });
    expect(parseCidr('2001:db8:0:0:0:0:0:1/128')).toEqual({ family: 6, prefix: 128, network: '2001:db8::1' });
    expect(parseCidr('2001:db8:abcd:12ff::1/64')).toEqual({ family: 6, prefix: 64, network: '2001:db8:abcd:12ff::' });
    expect(parseCidr('2001:db8:1:0:1:0:0:0/80')?.network).toBe('2001:db8:1:0:1::');
  });

  it('refuse les formes invalides', () => {
    const invalid = [
      '', '   ', 'abc', '203.0.113.0', '203.0.113.0/', '/24', '203.0.113.0/33', '203.0.113.0/-1', '203.0.113.0/2a', '203.0.113.0/24/1',
      '256.0.0.1/24', '1.2.3/24', '1.2.3.4.5/24', '01.2.3.4/24', '1.2.3.4 /24', '2001:db8::/129', '2001:::1/64', '2001:db8::g/64',
      '12345::/32', ':1/64', '2001:db8:1:2:3:4:5:6:7/64', '2001:db8%eth0::/64', '::ffff:203.0.113.5/128',
    ];
    for (const value of invalid) expect(parseCidr(value), value).toBeNull();
  });

  it('refuse les types non texte', () => {
    expect(parseCidr(undefined as unknown as string)).toBeNull();
    expect(parseCidr(42 as unknown as string)).toBeNull();
  });
});

describe('validateCidr', () => {
  it('accepte les préfixes minimaux (/24 en IPv4, /48 en IPv6) et renvoie la forme normalisée', () => {
    expect(validateCidr('203.0.113.0/24')).toEqual({ ok: true, cidr: '203.0.113.0/24' });
    expect(validateCidr('2001:db8:1::/48')).toEqual({ ok: true, cidr: '2001:db8:1::/48' });
    expect(validateCidr('203.0.113.9/24')).toEqual({ ok: true, cidr: '203.0.113.0/24' });
  });

  it('refuse une plage trop large avec un message dédié', () => {
    for (const value of ['198.51.100.0/23', '10.0.0.0/16', '0.0.0.0/0', '2001:db8::/32', '2001:db8:1::/47', '::/0']) {
      const result = validateCidr(value);
      expect(result.ok, value).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('cidr_too_broad');
        expect(result.message).toMatch(/trop large/);
      }
    }
  });

  it('refuse une saisie invalide, et explique l\'oubli du préfixe', () => {
    const invalid = validateCidr('pas-une-plage');
    expect(invalid).toMatchObject({ ok: false, code: 'invalid_cidr' });
    const noPrefix = validateCidr('203.0.113.5');
    expect(noPrefix).toMatchObject({ ok: false, code: 'invalid_cidr' });
    expect(!noPrefix.ok && noPrefix.message).toMatch(/préfixe/);
  });
});

describe('currentNetworkCidr', () => {
  it('propose l\'adresse courante en /32 (IPv4) ou /128 (IPv6)', () => {
    expect(currentNetworkCidr('203.0.113.50')).toBe('203.0.113.50/32');
    expect(currentNetworkCidr('2001:DB8::1')).toBe('2001:db8::1/128');
  });
  it('normalise les adresses IPv4 encapsulées', () => {
    expect(currentNetworkCidr('::ffff:203.0.113.50')).toBe('203.0.113.50/32');
  });
  it('renvoie null sans adresse exploitable', () => {
    for (const value of [null, undefined, '', 'inconnue', '300.1.1.1']) expect(currentNetworkCidr(value), String(value)).toBeNull();
  });
});

describe('trustedNetworkForm', () => {
  it('valide la plage, le libellé et le site facultatif', () => {
    expect(trustedNetworkForm({ cidr: '203.0.113.9/24', label: '  Siège  ', siteId: UUID, totpCode: '123 456' })).toEqual({
      ok: true,
      data: { cidr: '203.0.113.0/24', label: 'Siège', totpCode: '123456' },
    });
    expect(trustedNetworkForm({ cidr: '203.0.113.0/24', label: 'Siège', siteId: '', totpCode: '123456' })).toEqual({ ok: true, data: { cidr: '203.0.113.0/24', label: 'Siège', totpCode: '123456' } });
  });

  it('signale chaque champ fautif', () => {
    const result = trustedNetworkForm({ cidr: '10.0.0.0/8', label: 'x', siteId: 'pas-un-uuid', totpCode: '12' });
    expect(result).toEqual({
      ok: false,
      errors: {
        cidr: expect.stringContaining('trop large') as unknown,
        label: expect.stringContaining('2') as unknown,
        totpCode: expect.any(String) as unknown,
      },
    });
  });

  it('limite le libellé à 80 caractères', () => {
    expect(trustedNetworkForm({ cidr: '203.0.113.0/24', label: 'a'.repeat(81), totpCode: '123456' }).ok).toBe(false);
    expect(trustedNetworkForm({ cidr: '203.0.113.0/24', label: 'a'.repeat(80), totpCode: '123456' }).ok).toBe(true);
  });
});

describe('policyForm et transferOwnerForm', () => {
  it('accepte uniquement off_network et always', () => {
    expect(policyForm({ clinicalMfa: 'always', totpCode: '123456' })).toEqual({ ok: true, data: { clinicalMfa: 'always', totpCode: '123456' } });
    expect(policyForm({ clinicalMfa: 'off_network', totpCode: '123456' }).ok).toBe(true);
    expect(policyForm({ clinicalMfa: 'disabled', totpCode: '123456' }).ok).toBe(false);
    expect(policyForm({ totpCode: '123456' }).ok).toBe(false);
  });

  it('le transfert exige un identifiant d\'utilisateur valide', () => {
    expect(transferOwnerForm({ userId: UUID, totpCode: '654321' })).toEqual({ ok: true, data: { userId: UUID, totpCode: '654321' } });
    const invalid = transferOwnerForm({ userId: '../x', totpCode: '654321' });
    expect(invalid.ok).toBe(false);
    expect(!invalid.ok && invalid.errors.userId).toBeTruthy();
  });
});

describe('isOpaqueLinkToken', () => {
  it('reconnaît le jeton <uuid>.<secret> et refuse ce qui pourrait altérer un chemin', () => {
    expect(isOpaqueLinkToken(TOKEN)).toBe(true);
    for (const value of ['', 'abc', `${UUID}.court`, `${UUID}.${'a'.repeat(300)}`, `${TOKEN}/../x`, `${TOKEN}?a=1`, `${UUID}.aaaaaaaaaaaaaaaaaaaaaaaa bb`, `${UUID.toUpperCase()}.abcdefghijklmnopqrstuvwxyz`]) {
      expect(isOpaqueLinkToken(value), value).toBe(false);
    }
  });
});

describe('forgotPasswordForm et resendVerificationForm', () => {
  it('normalise le code établissement et l\'e-mail', () => {
    expect(forgotPasswordForm({ tenantSlug: ' Clinique-A ', email: ' Awa@Clinique.SN ' })).toEqual({
      ok: true,
      data: { tenantSlug: 'clinique-a', email: 'awa@clinique.sn' },
    });
    expect(resendVerificationForm({ tenantSlug: 'clinique-a', email: 'awa@clinique.sn' }).ok).toBe(true);
  });

  it('signale les champs invalides', () => {
    const result = forgotPasswordForm({ tenantSlug: 'A', email: 'pas-un-email' });
    expect(result.ok).toBe(false);
    expect(!result.ok && Object.keys(result.errors).sort()).toEqual(['email', 'tenantSlug']);
  });
});

describe('resetPasswordForm', () => {
  const base = { token: TOKEN, newPassword: 'un-mot-de-passe-long', confirmPassword: 'un-mot-de-passe-long' };

  it('valide le nouveau mot de passe et le code facultatif (espaces et tirets retirés)', () => {
    expect(resetPasswordForm(base)).toEqual({ ok: true, data: { token: TOKEN, newPassword: 'un-mot-de-passe-long' } });
    expect(resetPasswordForm({ ...base, mfaCode: '123 456' })).toEqual({ ok: true, data: { token: TOKEN, newPassword: 'un-mot-de-passe-long', mfaCode: '123456' } });
    expect(resetPasswordForm({ ...base, mfaCode: 'abcd-efghj2' })).toMatchObject({ ok: true, data: { mfaCode: 'ABCDEFGHJ2' } });
  });

  it('refuse une confirmation différente, un mot de passe trop court et un code mal formé', () => {
    const mismatch = resetPasswordForm({ ...base, confirmPassword: 'autre-chose-long' });
    expect(!mismatch.ok && mismatch.errors.confirmPassword).toMatch(/ne correspondent pas/);
    const short = resetPasswordForm({ ...base, newPassword: 'court', confirmPassword: 'court' });
    expect(!short.ok && short.errors.newPassword).toMatch(/10/);
    const code = resetPasswordForm({ ...base, mfaCode: '12' });
    expect(!code.ok && code.errors.mfaCode).toBeTruthy();
  });

  it('refuse un jeton mal formé sans l\'écho dans le message', () => {
    const result = resetPasswordForm({ ...base, token: 'jeton/../secret' });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});

describe('safeTenantSlug', () => {
  it('ne reprend qu\'un code établissement valide', () => {
    expect(safeTenantSlug('clinique-a')).toBe('clinique-a');
    for (const value of ['', undefined, null, 'ab', 'A-B-C', 'x/../y', '-abc', 'abc-', 'a b c', 'a'.repeat(49)]) expect(safeTenantSlug(value), String(value)).toBeNull();
  });
});

describe('code du second facteur (opérations de pouvoir, docs/11 §14.1)', () => {
  it('exige 6 chiffres sur la politique, les réseaux, le transfert et la suppression', () => {
    for (const code of [undefined, '', '12345', '1234567', 'abcdef', '12 34 5x']) {
      expect(policyForm({ clinicalMfa: 'always', totpCode: code }).ok, String(code)).toBe(false);
      expect(trustedNetworkForm({ cidr: '203.0.113.0/24', label: 'Siège', totpCode: code }).ok, String(code)).toBe(false);
      expect(transferOwnerForm({ userId: UUID, totpCode: code }).ok, String(code)).toBe(false);
      expect(removeNetworkForm({ networkId: UUID, totpCode: code }).ok, String(code)).toBe(false);
    }
  });

  it('message d\'erreur sur le champ totpCode', () => {
    const result = policyForm({ clinicalMfa: 'always' });
    expect(!result.ok && result.errors.totpCode).toMatch(/6 chiffres/);
  });

  it('suppression d\'une plage : identifiant et code', () => {
    expect(removeNetworkForm({ networkId: UUID, totpCode: '1 2 3 4 5 6' })).toEqual({ ok: true, data: { networkId: UUID, totpCode: '123456' } });
    expect(removeNetworkForm({ networkId: '../x', totpCode: '123456' }).ok).toBe(false);
  });
});

describe('reasonForm (réinitialisation du second facteur, déverrouillage)', () => {
  it('exige un motif de 10 à 500 caractères, nettoyé', () => {
    expect(reasonForm({ reason: '  Collègue en face à face, téléphone perdu.  ' })).toEqual({ ok: true, data: { reason: 'Collègue en face à face, téléphone perdu.' } });
    expect(reasonForm({ reason: 'a'.repeat(10) }).ok).toBe(true);
    expect(reasonForm({ reason: 'a'.repeat(500) }).ok).toBe(true);
  });
  it('refuse un motif absent, trop court (après nettoyage) ou trop long', () => {
    for (const reason of [undefined, '', '   ', 'court', '   court     ', 'a'.repeat(501)]) {
      const result = reasonForm({ reason });
      expect(result.ok, String(reason)).toBe(false);
      expect(!result.ok && result.errors.reason).toMatch(/10/);
    }
  });
});
