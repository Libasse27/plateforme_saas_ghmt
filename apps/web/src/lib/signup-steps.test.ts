import { describe, expect, it } from 'vitest';
import { stepIndexOfFirstError, validateSignupStep } from './signup-steps';

describe('validateSignupStep', () => {
  it('accepte une étape établissement valide', () => {
    expect(
      validateSignupStep('establishment', {
        'establishment.slug': 'clinique-sante',
        'establishment.legalName': 'Clinique Santé SARL',
        'establishment.establishmentType': 'clinic',
        'establishment.countryCode': 'sn',
        'establishment.baseCurrency': 'XOF',
        'establishment.timezone': 'Africa/Dakar',
      }),
    ).toEqual({});
  });

  it('retourne des erreurs préfixées par étape, en français', () => {
    const errors = validateSignupStep('establishment', { 'establishment.slug': 'A', 'establishment.establishmentType': 'x' });
    expect(Object.keys(errors).every((k) => k.startsWith('establishment.'))).toBe(true);
    expect(errors['establishment.legalName']).toBeDefined();
    expect(errors['establishment.establishmentType']).toBe('Valeur non reconnue.');
  });

  it('valide le site principal', () => {
    expect(validateSignupStep('mainSite', { 'mainSite.code': 'MAIN', 'mainSite.name': 'Site central' })).toEqual({});
    expect(validateSignupStep('mainSite', {})['mainSite.code']).toBeDefined();
  });

  it('vérifie la confirmation du mot de passe administrateur', () => {
    const base = { 'admin.fullName': 'Aminata Diallo', 'admin.email': 'a@clinique.sn', 'admin.password': 'un-mot-de-passe-long' };
    expect(validateSignupStep('admin', { ...base, 'admin.confirmPassword': 'un-mot-de-passe-long' })).toEqual({});
    expect(validateSignupStep('admin', { ...base, 'admin.confirmPassword': 'autre' })['admin.confirmPassword']).toContain('ne correspondent pas');
    expect(validateSignupStep('admin', { ...base, 'admin.password': 'court', 'admin.confirmPassword': 'court' })['admin.password']).toContain('12');
  });
});

describe('stepIndexOfFirstError', () => {
  it('retrouve l\'étape de la première erreur', () => {
    expect(stepIndexOfFirstError({ 'establishment.slug': 'x' })).toBe(0);
    expect(stepIndexOfFirstError({ 'mainSite.code': 'x' })).toBe(1);
    expect(stepIndexOfFirstError({ 'admin.email': 'x', 'mainSite.code': 'y' })).toBe(2);
    expect(stepIndexOfFirstError({})).toBe(0);
    expect(stepIndexOfFirstError({ inconnu: 'x' })).toBe(0);
  });
});
