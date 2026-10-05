import { describe, expect, it } from 'vitest';
import { PLATFORM_MFA_PATH, hasPlatformPermission, parsePlatformMe, platformStepPath, visiblePlatformNav } from './platform-me';

const RAW = {
  id: 'u1',
  email: 'root@ghmt.test',
  fullName: 'Awa Root',
  role: 'billing',
  mfaEnrolled: true,
  mfaVerified: true,
  permissions: ['tenants:read', 'plans:read', 'invoices:read', 'dashboard:read', 'bogus:perm'],
};

describe('parsePlatformMe', () => {
  it('normalise la réponse de GET /platform/auth/me et ignore les permissions inconnues', () => {
    const me = parsePlatformMe(RAW);
    expect(me).toMatchObject({ id: 'u1', fullName: 'Awa Root', role: 'billing', mfaEnrolled: true, mfaVerified: true });
    expect(me.permissions).toEqual(['tenants:read', 'plans:read', 'invoices:read', 'dashboard:read']);
  });
  it('replie sur l\'e-mail pour le nom, refuse un rôle inconnu et lève sur une réponse vide', () => {
    expect(parsePlatformMe({ ...RAW, fullName: '' }).fullName).toBe('root@ghmt.test');
    expect(parsePlatformMe({ ...RAW, role: 'hacker' }).role).toBe('support');
    expect(() => parsePlatformMe(null)).toThrow();
  });
});

describe('permissions et étapes', () => {
  it('hasPlatformPermission lit la liste renvoyée par l\'API', () => {
    const me = parsePlatformMe(RAW);
    expect(hasPlatformPermission(me, 'plans:read')).toBe(true);
    expect(hasPlatformPermission(me, 'plans:write')).toBe(false);
  });
  it('impose l\'enrôlement/la vérification MFA tant que la session n\'est pas vérifiée', () => {
    expect(platformStepPath(parsePlatformMe({ ...RAW, mfaVerified: false }))).toBe(PLATFORM_MFA_PATH);
    expect(platformStepPath(parsePlatformMe(RAW))).toBeNull();
  });
  it('filtre le menu selon les permissions', () => {
    const labels = visiblePlatformNav(parsePlatformMe(RAW)).map((item) => item.label);
    expect(labels).toEqual(['Tableau de bord', 'Établissements', 'Plans', 'Factures SaaS']);
    const support = visiblePlatformNav(parsePlatformMe({ ...RAW, role: 'support', permissions: ['dashboard:read', 'tenants:read'] })).map((i) => i.label);
    expect(support).toEqual(['Tableau de bord', 'Établissements']);
  });
});
