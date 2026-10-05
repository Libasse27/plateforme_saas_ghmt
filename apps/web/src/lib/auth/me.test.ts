import { describe, expect, it } from 'vitest';
import { canUse, hasModule, hasPermission, needsMfaStep, parseMe, requiredStepPath } from './me';
import { isActivePath, visibleNav } from './nav';

const RAW = {
  user: { id: 'u1', fullName: 'Aminata Diallo', email: 'a@x.sn', mustChangePassword: true },
  tenant: { id: 't1', slug: 'clinique-a', name: 'Clinique A', timezone: 'Africa/Abidjan', countryCode: 'CI', baseCurrency: 'XOF' },
  permissions: ['patients:patient:read', 'appointments:*:*'],
  modules: ['patients', { code: 'appointments' }, 42],
  mfa: { enrolled: true, verified: false, required: true },
};

describe('parseMe', () => {
  it('normalise utilisateur, établissement, modules et MFA', () => {
    const me = parseMe(RAW);
    expect(me.user.fullName).toBe('Aminata Diallo');
    expect(me.tenant).toEqual({ id: 't1', slug: 'clinique-a', name: 'Clinique A', timezone: 'Africa/Abidjan', countryCode: 'CI', baseCurrency: 'XOF' });
    expect(me.user.mustChangePassword).toBe(true);
    expect(me.modules).toEqual(['patients', 'appointments']);
    expect(me.mfa).toEqual({ enrolled: true, verified: false, required: true });
  });

  it('applique des valeurs par défaut sûres', () => {
    const me = parseMe({ user: { email: 'b@x.sn' }, tenant: { slug: 's' } });
    expect(me.user.fullName).toBe('b@x.sn');
    expect(me.tenant.name).toBe('s');
    expect(me.tenant.timezone).toBe('Africa/Dakar');
    expect(me.permissions).toEqual([]);
    expect(me.user.mustChangePassword).toBe(false);
    expect(me.tenant.countryCode).toBe('');
    expect(me.mfa).toEqual({ enrolled: false, verified: false, required: false });
    expect(parseMe({ user: {}, tenant: {} }).user.fullName).toBe('Utilisateur');
    expect(parseMe({ tenant: {}, user: {}, permissions: 'x' }).permissions).toEqual([]);
  });

  it('rejette une réponse vide ou non objet', () => {
    expect(() => parseMe(null)).toThrow();
    expect(() => parseMe([])).toThrow();
    expect(() => parseMe({})).toThrow();
  });
});

describe('contrôles de droits', () => {
  const me = parseMe(RAW);
  it('gère les permissions exactes et les jokers', () => {
    expect(hasPermission(me, 'patients:patient:read')).toBe(true);
    expect(hasPermission(me, 'patients:patient:create')).toBe(false);
    expect(hasPermission(me, 'appointments:appointment:create')).toBe(true);
  });
  it('exige le module en plus de la permission', () => {
    expect(hasModule(me, 'patients')).toBe(true);
    expect(hasModule(me, 'billing')).toBe(false);
    expect(canUse({ ...me, modules: [] }, 'patients', 'patients:patient:read')).toBe(false);
    expect(canUse(me, 'patients', 'patients:patient:read')).toBe(true);
  });
  it('needsMfaStep : requise et non vérifiée', () => {
    expect(needsMfaStep(me)).toBe(true);
    expect(needsMfaStep({ mfa: { enrolled: true, verified: true, required: true } })).toBe(false);
    expect(needsMfaStep({ mfa: { enrolled: false, verified: false, required: false } })).toBe(false);
  });
});

describe('requiredStepPath', () => {
  const base = parseMe(RAW);
  it('impose le changement de mot de passe avant l\'étape MFA', () => {
    expect(requiredStepPath(base)).toBe('/securite/mot-de-passe');
  });
  it('renvoie l\'étape MFA une fois le mot de passe changé', () => {
    expect(requiredStepPath({ ...base, user: { ...base.user, mustChangePassword: false } })).toBe('/securite/mfa');
  });
  it('ne renvoie rien si aucune étape n\'est requise', () => {
    expect(requiredStepPath({ ...base, user: { ...base.user, mustChangePassword: false }, mfa: { enrolled: true, verified: true, required: true } })).toBeNull();
  });
  it('permet d\'ignorer chaque étape sur sa propre page', () => {
    expect(requiredStepPath(base, { allowPasswordChange: true })).toBe('/securite/mfa');
    expect(requiredStepPath(base, { allowPasswordChange: true, allowMfaPending: true })).toBeNull();
  });
});

describe('navigation', () => {
  it('masque les entrées sans permission ou sans module', () => {
    const me = parseMe({ ...RAW, permissions: ['patients:patient:read'], modules: ['patients'] });
    expect(visibleNav(me).map((i) => i.href)).toEqual(['/', '/patients', '/notifications', '/securite/mfa', '/securite/mot-de-passe']);
  });
  it('affiche tout pour un administrateur complet', () => {
    expect(visibleNav(parseMe(RAW)).map((i) => i.href)).toEqual(['/', '/patients', '/rendez-vous', '/notifications', '/administration/praticiens', '/securite/mfa', '/securite/mot-de-passe']);
  });
  it('isActivePath', () => {
    expect(isActivePath('/', '/')).toBe(true);
    expect(isActivePath('/', '/patients')).toBe(false);
    expect(isActivePath('/patients', '/patients/abc')).toBe(true);
    expect(isActivePath('/patients', '/patientsx')).toBe(false);
  });
});
