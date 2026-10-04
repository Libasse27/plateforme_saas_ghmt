import { describe, expect, it } from 'vitest';
import {
  acceptInvitationSchema,
  changePasswordSchema,
  createPatientSchema,
  createUserSchema,
  deletePatientSchema,
  logoutSchema,
  searchPatientsSchema,
  updatePatientSchema,
} from './index';

const VALID_PASSWORD = 'Motdepasse-solide-2026';

function isoDateYearsAgo(years: number, extraDays = 0): string {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - years);
  date.setUTCDate(date.getUTCDate() + extraDays);
  return date.toISOString().slice(0, 10);
}

describe('createUserSchema (invitation)', () => {
  it('n’accepte plus de mot de passe imposé par l’administrateur', () => {
    const parsed = createUserSchema.parse({ fullName: 'Awa Diop', email: 'AWA@Test.sn', password: VALID_PASSWORD });
    expect(parsed).not.toHaveProperty('password');
    expect(parsed.email).toBe('awa@test.sn');
    expect(parsed.roleAssignments).toEqual([]);
  });
});

describe('searchPatientsSchema (C1)', () => {
  it('accepte un IPP au format P26-0000042 et refuse les autres', () => {
    expect(searchPatientsSchema.safeParse({ ipp: 'P26-0000042' }).success).toBe(true);
    expect(searchPatientsSchema.safeParse({ ipp: 'P26-42' }).success).toBe(false);
    expect(searchPatientsSchema.safeParse({ ipp: 'p26-0000042' }).success).toBe(false);
  });

  it('borne q à 2..100 caractères et limit à 1..100 (20 par défaut)', () => {
    expect(searchPatientsSchema.safeParse({ q: 'a' }).success).toBe(false);
    expect(searchPatientsSchema.safeParse({ q: 'x'.repeat(101) }).success).toBe(false);
    expect(searchPatientsSchema.safeParse({ q: 'ab', limit: 101 }).success).toBe(false);
    expect(searchPatientsSchema.parse({ q: 'ab' }).limit).toBe(20);
  });

  it('laisse le contrôle « au moins un critère » au service (code dédié)', () => {
    expect(searchPatientsSchema.safeParse({}).success).toBe(true);
  });
});

describe('createPatientSchema (A9, C3)', () => {
  const base = { lastName: 'Diop', firstName: 'Awa' };

  it('refuse une date de naissance future', () => {
    expect(createPatientSchema.safeParse({ ...base, birthDate: isoDateYearsAgo(-1) }).success).toBe(false);
  });

  it('tolère demain (UTC) pour les fuseaux en avance, refuse après-demain ; le contrôle exact est côté service', () => {
    const dayOffset = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
    expect(createPatientSchema.safeParse({ ...base, birthDate: dayOffset(1) }).success).toBe(true);
    expect(updatePatientSchema.safeParse({ birthDate: dayOffset(1) }).success).toBe(true);
    expect(createPatientSchema.safeParse({ ...base, birthDate: dayOffset(2) }).success).toBe(false);
  });

  it('accepte aujourd’hui et refuse un âge supérieur à 130 ans', () => {
    expect(createPatientSchema.safeParse({ ...base, birthDate: new Date().toISOString().slice(0, 10) }).success).toBe(true);
    expect(createPatientSchema.safeParse({ ...base, birthDate: isoDateYearsAgo(131) }).success).toBe(false);
    expect(createPatientSchema.safeParse({ ...base, birthDate: isoDateYearsAgo(129) }).success).toBe(true);
  });

  it('exige une date de naissance quand elle est marquée estimée', () => {
    expect(createPatientSchema.safeParse({ ...base, birthDateEstimated: true }).success).toBe(false);
    expect(createPatientSchema.safeParse({ ...base, birthDate: '1990-01-01', birthDateEstimated: true }).success).toBe(true);
  });

  it('borne forceReason à 3..500 caractères', () => {
    expect(createPatientSchema.safeParse({ ...base, forceReason: 'ab' }).success).toBe(false);
    expect(createPatientSchema.safeParse({ ...base, forceReason: 'x'.repeat(501) }).success).toBe(false);
    expect(createPatientSchema.safeParse({ ...base, forceReason: 'Homonyme confirmé' }).success).toBe(true);
  });
});

describe('updatePatientSchema (A9)', () => {
  it('accepte null pour effacer phone, email, nationalId, address, city, bloodGroup', () => {
    const parsed = updatePatientSchema.parse({ phone: null, email: null, nationalId: null, address: null, city: null, bloodGroup: null });
    expect(parsed).toMatchObject({ phone: null, email: null, nationalId: null, address: null, city: null, bloodGroup: null });
  });

  it('refuse null pour les champs d’identité obligatoires', () => {
    expect(updatePatientSchema.safeParse({ lastName: null }).success).toBe(false);
    expect(updatePatientSchema.safeParse({ birthDate: null }).success).toBe(false);
  });

  it('applique aussi la borne de date de naissance', () => {
    expect(updatePatientSchema.safeParse({ birthDate: isoDateYearsAgo(-1) }).success).toBe(false);
  });
});

describe('deletePatientSchema (C5)', () => {
  it('exige un motif de 3 à 500 caractères', () => {
    expect(deletePatientSchema.safeParse({}).success).toBe(false);
    expect(deletePatientSchema.safeParse({ reason: 'ab' }).success).toBe(false);
    expect(deletePatientSchema.safeParse({ reason: 'Doublon avéré' }).success).toBe(true);
  });
});

describe('schémas de mot de passe et déconnexion (C6 à C8)', () => {
  it('acceptInvitationSchema impose la longueur minimale', () => {
    expect(acceptInvitationSchema.safeParse({ password: 'court' }).success).toBe(false);
    expect(acceptInvitationSchema.safeParse({ password: VALID_PASSWORD }).success).toBe(true);
  });

  it('changePasswordSchema exige les deux mots de passe', () => {
    expect(changePasswordSchema.safeParse({ currentPassword: VALID_PASSWORD }).success).toBe(false);
    expect(changePasswordSchema.safeParse({ currentPassword: VALID_PASSWORD, newPassword: 'court' }).success).toBe(false);
    expect(changePasswordSchema.safeParse({ currentPassword: VALID_PASSWORD, newPassword: `${VALID_PASSWORD}!` }).success).toBe(true);
  });

  it('logoutSchema rend le jeton de rafraîchissement optionnel', () => {
    expect(logoutSchema.safeParse({}).success).toBe(true);
    expect(logoutSchema.safeParse({ refreshToken: 'x'.repeat(60) }).success).toBe(true);
    expect(logoutSchema.safeParse({ refreshToken: 'court' }).success).toBe(false);
  });
});
