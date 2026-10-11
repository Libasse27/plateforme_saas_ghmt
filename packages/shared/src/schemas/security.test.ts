import { describe, expect, it } from 'vitest';
import {
  CLINICAL_MFA_MODES,
  CLINICAL_PERMISSION_MODULES,
  LOGIN_DELAY_SECONDS,
  MFA_EMAIL_CODE_TTL_MINUTES,
  PASSWORD_RESET_TTL_MINUTES,
  TRUSTED_NETWORK_MAX,
  TRUSTED_NETWORK_MIN_PREFIX,
  createTrustedNetworkSchema,
  forgotPasswordSchema,
  isClinicalPermission,
  isReservedAddress,
  isReservedNetwork,
  removeTrustedNetworkSchema,
  reasonSchema,
  loginDelaySeconds,
  mfaSetupSchema,
  parseCidr,
  passwordResetTokenSchema,
  resetPasswordSchema,
  transferOwnershipSchema,
  updateSecurityPolicySchema,
} from './security';

const TENANT = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const TOKEN = `${TENANT}.${'a'.repeat(43)}`;

describe('constantes de sécurité', () => {
  it('fige le barème du délai progressif et son plafond', () => {
    expect(LOGIN_DELAY_SECONDS).toEqual([0, 0, 0, 0, 30, 60, 120, 300, 600, 900]);
    expect(CLINICAL_MFA_MODES).toEqual(['off_network', 'always']);
    expect(TRUSTED_NETWORK_MAX).toBe(50);
    expect(TRUSTED_NETWORK_MIN_PREFIX).toEqual({ v4: 24, v6: 48 });
    expect(PASSWORD_RESET_TTL_MINUTES).toBe(30);
    expect(MFA_EMAIL_CODE_TTL_MINUTES).toBe(10);
  });

  it('liste les modules cliniques de la décision D5', () => {
    expect([...CLINICAL_PERMISSION_MODULES]).toEqual(['consultations', 'nursing', 'maternity', 'inpatient', 'laboratory', 'imaging', 'pharmacy']);
    expect(isClinicalPermission('consultations:consultation:read')).toBe(true);
    expect(isClinicalPermission('pharmacy:dispensation:read')).toBe(true);
    expect(isClinicalPermission('patients:patient:read')).toBe(false);
    expect(isClinicalPermission('cashier:payment:create')).toBe(false);
  });

  it('exclut les permissions de stock pharmacie (décision 22) mais pas la dispensation', () => {
    for (const permission of ['pharmacy:drug:read', 'pharmacy:stock_movement:read', 'pharmacy:stock_movement:create']) {
      expect(isClinicalPermission(permission), permission).toBe(false);
    }
    expect(isClinicalPermission('pharmacy:dispensation:create')).toBe(true);
    expect(isClinicalPermission('pharmacy:drug:update')).toBe(true);
    expect(isClinicalPermission('inpatient:admission:read')).toBe(true);
  });
});

describe('loginDelaySeconds (D3)', () => {
  it('ne retarde pas les quatre premiers échecs', () => {
    for (const failures of [0, 1, 2, 3, 4]) expect(loginDelaySeconds(failures)).toBe(0);
  });

  it('applique le palier du n-ième échec consécutif', () => {
    expect(loginDelaySeconds(5)).toBe(30);
    expect(loginDelaySeconds(6)).toBe(60);
    expect(loginDelaySeconds(7)).toBe(120);
    expect(loginDelaySeconds(8)).toBe(300);
    expect(loginDelaySeconds(9)).toBe(600);
    expect(loginDelaySeconds(10)).toBe(900);
  });

  it('plafonne à 900 secondes au-delà du dixième échec', () => {
    expect(loginDelaySeconds(11)).toBe(900);
    expect(loginDelaySeconds(10_000)).toBe(900);
  });

  it('traite les valeurs invalides comme aucun échec', () => {
    expect(loginDelaySeconds(-3)).toBe(0);
    expect(loginDelaySeconds(Number.NaN)).toBe(0);
  });
});

describe('parseCidr', () => {
  it('analyse un réseau IPv4 et le normalise (bits d’hôte à zéro)', () => {
    expect(parseCidr('203.0.113.0/24')).toEqual({ family: 4, prefix: 24, network: '203.0.113.0/24' });
    expect(parseCidr('203.0.113.77/24')).toEqual({ family: 4, prefix: 24, network: '203.0.113.0/24' });
    expect(parseCidr('  10.12.200.9/20 ')).toEqual({ family: 4, prefix: 20, network: '10.12.192.0/20' });
  });

  it('accepte une adresse seule /32', () => {
    expect(parseCidr('198.51.100.7/32')).toEqual({ family: 4, prefix: 32, network: '198.51.100.7/32' });
  });

  it('analyse et compresse un réseau IPv6', () => {
    expect(parseCidr('2001:db8::/32')).toEqual({ family: 6, prefix: 32, network: '2001:db8::/32' });
    expect(parseCidr('2001:0DB8:0000:0000:0000:0000:0000:0001/128')).toEqual({ family: 6, prefix: 128, network: '2001:db8::1/128' });
    expect(parseCidr('2001:db8:abcd:12ff::/48')).toEqual({ family: 6, prefix: 48, network: '2001:db8:abcd::/48' });
  });

  it('ramène une adresse IPv4 encapsulée ::ffff:a.b.c.d à son IPv4', () => {
    expect(parseCidr('::ffff:203.0.113.5/128')).toEqual({ family: 4, prefix: 32, network: '203.0.113.5/32' });
    expect(parseCidr('::ffff:203.0.113.0/120')).toEqual({ family: 4, prefix: 24, network: '203.0.113.0/24' });
  });

  it('refuse les valeurs mal formées', () => {
    for (const bad of ['', 'abc', '203.0.113.0', '203.0.113.0/', '203.0.113.0/33', '256.0.0.1/24', '1.2.3/24', '1.2.3.4.5/24', '1.2.3.4/-1', '1.2.3.4/2x', '01.2.3.4/24', '2001:db8::/129', '2001:db8:::1/64', '12345::/32', 'g::/32', '1.2.3.4/24/1']) {
      expect(parseCidr(bad), bad).toBeNull();
    }
    expect(parseCidr(undefined as unknown as string)).toBeNull();
    expect(parseCidr(42 as unknown as string)).toBeNull();
  });

  it('retourne tout de même les préfixes trop larges (le contrôle de largeur est séparé)', () => {
    expect(parseCidr('10.0.0.0/8')).toEqual({ family: 4, prefix: 8, network: '10.0.0.0/8' });
    expect(parseCidr('0.0.0.0/0')).toEqual({ family: 4, prefix: 0, network: '0.0.0.0/0' });
  });
});

describe('schémas d’authentification', () => {
  it('forgotPasswordSchema normalise l’e-mail', () => {
    expect(forgotPasswordSchema.parse({ tenantSlug: 'clinique-a', email: 'Awa@Test.SN' })).toEqual({ tenantSlug: 'clinique-a', email: 'awa@test.sn' });
    expect(forgotPasswordSchema.safeParse({ tenantSlug: 'X', email: 'awa@test.sn' }).success).toBe(false);
    expect(forgotPasswordSchema.safeParse({ tenantSlug: 'clinique-a', email: 'pas-un-email' }).success).toBe(false);
  });

  it('passwordResetTokenSchema valide la forme <tenantId>.<secret>', () => {
    expect(passwordResetTokenSchema.safeParse({ token: TOKEN }).success).toBe(true);
    expect(passwordResetTokenSchema.safeParse({ token: 'court' }).success).toBe(false);
    expect(passwordResetTokenSchema.safeParse({ token: `${TENANT}.${'!'.repeat(43)}` }).success).toBe(false);
    expect(passwordResetTokenSchema.safeParse({ token: `${TOKEN}${'a'.repeat(300)}` }).success).toBe(false);
  });

  it('resetPasswordSchema impose la longueur du mot de passe et le motif du code', () => {
    expect(resetPasswordSchema.safeParse({ token: TOKEN, newPassword: 'Motdepasse-solide-2026' }).success).toBe(true);
    expect(resetPasswordSchema.safeParse({ token: TOKEN, newPassword: 'court' }).success).toBe(false);
    expect(resetPasswordSchema.safeParse({ token: TOKEN, newPassword: 'Motdepasse-solide-2026', mfaCode: '123456' }).success).toBe(true);
    expect(resetPasswordSchema.safeParse({ token: TOKEN, newPassword: 'Motdepasse-solide-2026', mfaCode: 'ABCDEFGHJK' }).success).toBe(true);
    expect(resetPasswordSchema.safeParse({ token: TOKEN, newPassword: 'Motdepasse-solide-2026', mfaCode: '12' }).success).toBe(false);
  });

  it('mfaSetupSchema accepte un corps vide ou un code à 6 chiffres', () => {
    expect(mfaSetupSchema.safeParse({}).success).toBe(true);
    expect(mfaSetupSchema.safeParse({ emailCode: '012345' }).success).toBe(true);
    expect(mfaSetupSchema.safeParse({ emailCode: '12345' }).success).toBe(false);
    expect(mfaSetupSchema.safeParse({ emailCode: '12345a' }).success).toBe(false);
  });
});

describe('schémas de politique de sécurité', () => {
  it('updateSecurityPolicySchema refuse un mode inconnu (pas de mode « disabled »)', () => {
    expect(updateSecurityPolicySchema.safeParse({ clinicalMfa: 'always' }).success).toBe(true);
    expect(updateSecurityPolicySchema.safeParse({ clinicalMfa: 'off_network' }).success).toBe(true);
    expect(updateSecurityPolicySchema.safeParse({ clinicalMfa: 'disabled' }).success).toBe(false);
  });

  it('createTrustedNetworkSchema exige un libellé de 2 à 80 caractères ; un siteId n’est plus accepté (décision 26)', () => {
    expect(createTrustedNetworkSchema.parse({ cidr: ' 203.0.113.0/24 ', label: 'Siège' })).toEqual({ cidr: '203.0.113.0/24', label: 'Siège' });
    expect(createTrustedNetworkSchema.safeParse({ cidr: '203.0.113.0/24', label: 'S' }).success).toBe(false);
    expect(createTrustedNetworkSchema.safeParse({ cidr: '203.0.113.0/24', label: 'x'.repeat(81) }).success).toBe(false);
    expect(createTrustedNetworkSchema.parse({ cidr: '203.0.113.0/24', label: 'Siège', siteId: TENANT })).not.toHaveProperty('siteId');
    expect(createTrustedNetworkSchema.safeParse({ cidr: '', label: 'Siège' }).success).toBe(false);
  });

  it('transferOwnershipSchema exige un identifiant d’utilisateur', () => {
    expect(transferOwnershipSchema.safeParse({ userId: TENANT }).success).toBe(true);
    expect(transferOwnershipSchema.safeParse({ userId: 'x' }).success).toBe(false);
  });
});

describe('plages réservées (décision 23)', () => {
  const reserved = (cidr: string): boolean => isReservedNetwork(parseCidr(cidr)!);

  it.each(['10.1.2.0/24', '172.16.5.0/24', '192.168.1.0/24', '100.64.0.0/24', '127.0.0.0/24', '169.254.10.0/24', '0.1.2.0/24', '224.0.0.0/24', '240.0.0.0/24', '192.0.2.0/24', '198.51.100.0/24', '203.0.113.0/24', '198.18.0.0/24', 'fc00:1::/48', 'fd12:3456:789a::/48', 'fe80:1::/48', 'ff02:1::/48', '2001:db8:1::/48', '::1/128'])(
    'refuse %s',
    (cidr) => expect(reserved(cidr)).toBe(true),
  );

  it.each(['45.60.10.0/24', '51.15.20.0/24', '8.8.8.0/24', '2a01:e0a:1234::/48', '2606:4700:10::/48'])('accepte la plage publique %s', (cidr) => {
    expect(reserved(cidr)).toBe(false);
  });

  it.each([
    // Chevauchement : une plage plus large qu'un bloc réservé qui le contient est refusée.
    ['::/48', 'contient ::/96 et ::ffff:0:0/96'],
    ['0:0:0::/48', 'forme longue de ::/48'],
    ['::/64', 'contient ::ffff:0:0/96'],
    ['100::/48', 'contient 100::/64 (rejet)'],
    ['64:ff9b::/48', 'contient 64:ff9b::/96 (NAT64)'],
    ['64:ff9b::/96', 'NAT64'],
    ['2002:2952:a00::/48', '6to4 (2002::/16)'],
    ['2001:0:1::/48', 'Teredo (2001::/32)'],
    ['::102:300/120', 'IPv4 compatible (::/96)'],
  ])('refuse %s (%s)', (cidr) => expect(reserved(cidr)).toBe(true));

  it.each(['2001:4860::/48', '2001:1::/48'])('accepte %s (hors Teredo et documentation)', (cidr) => expect(reserved(cidr)).toBe(false));

  it('classe une adresse seule : privées et spéciales sont absentes, publiques non', () => {
    for (const ip of ['10.0.0.1', '192.168.0.9', '127.0.0.1', '::1', 'fe80::1', '169.254.1.1', '203.0.113.9']) expect(isReservedAddress(ip), ip).toBe(true);
    for (const ip of ['45.60.10.9', '8.8.4.4', '2a01:e0a:1234::9']) expect(isReservedAddress(ip), ip).toBe(false);
    expect(isReservedAddress('pas-une-ip')).toBe(true);
    for (const ip of ['::ffff:a00:1', '64:ff9b::a00:1', '2002:a00:1::1', '2001:0:4136::1', '100::1']) expect(isReservedAddress(ip), ip).toBe(true);
  });
});

describe('étape de confirmation par code TOTP (décision 23)', () => {
  it('createTrustedNetworkSchema, updateSecurityPolicySchema et transferOwnershipSchema acceptent un totpCode à 6 chiffres facultatif', () => {
    expect(createTrustedNetworkSchema.parse({ cidr: '45.60.10.0/24', label: 'Siège', totpCode: '012345' }).totpCode).toBe('012345');
    expect(updateSecurityPolicySchema.parse({ clinicalMfa: 'always', totpCode: '012345' }).totpCode).toBe('012345');
    expect(transferOwnershipSchema.parse({ userId: TENANT, totpCode: '012345' }).totpCode).toBe('012345');
    expect(updateSecurityPolicySchema.safeParse({ clinicalMfa: 'always' }).success).toBe(true);
    expect(updateSecurityPolicySchema.safeParse({ clinicalMfa: 'always', totpCode: '12345' }).success).toBe(false);
  });

  it('removeTrustedNetworkSchema porte le code dans le corps', () => {
    expect(removeTrustedNetworkSchema.parse({ totpCode: '000111' })).toEqual({ totpCode: '000111' });
    expect(removeTrustedNetworkSchema.parse({})).toEqual({});
  });

  it('reasonSchema exige un motif de 10 à 500 caractères (espaces rognés)', () => {
    expect(reasonSchema.safeParse({ reason: 'Appel de contrôle effectué' }).success).toBe(true);
    expect(reasonSchema.safeParse({ reason: '  court  ' }).success).toBe(false);
    expect(reasonSchema.safeParse({ reason: 'x'.repeat(501) }).success).toBe(false);
    expect(reasonSchema.safeParse({}).success).toBe(false);
  });
});
