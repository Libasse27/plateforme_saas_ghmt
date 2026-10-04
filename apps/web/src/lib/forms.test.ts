import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createPatientSchema, loginSchema, signupTenantSchema } from '@ghmt/shared';
import { fieldErrorsFromZod, formDataToFlat, issueMessage, nestFlat, publicValues, safeNextPath } from './forms';

describe('formDataToFlat / nestFlat', () => {
  it('ignore les champs techniques Next et les fichiers', () => {
    const fd = new FormData();
    fd.set('$ACTION_ID_abc', 'x');
    fd.set('a.b', ' 1 ');
    fd.set('file', new File(['x'], 'f.txt'));
    expect(formDataToFlat(fd)).toEqual({ 'a.b': ' 1 ' });
  });

  it('imbrique les chemins pointés, rogne et omet les vides', () => {
    expect(nestFlat({ 'admin.email': ' a@b.sn ', 'admin.fullName': '', slug: 'x', 'a.b.c': '1' })).toEqual({
      admin: { email: 'a@b.sn' },
      slug: 'x',
      a: { b: { c: '1' } },
    });
  });

  it('écrase un conflit scalaire/objet sans lever d\'erreur et bloque __proto__', () => {
    expect(nestFlat({ a: '1', 'a.b': '2' })).toEqual({ a: { b: '2' } });
    const polluted = nestFlat({ '__proto__.x': '1', 'constructor.y': '2' });
    expect(polluted).toEqual({});
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('publicValues retire les mots de passe et codes', () => {
    expect(publicValues({ email: 'a', password: 'p', 'admin.password': 'q', code: '123456', name: 'n' })).toEqual({ email: 'a', name: 'n' });
  });
});

describe('validation Zod → messages français', () => {
  it('traduit les messages par défaut du schéma patient', () => {
    const result = createPatientSchema.safeParse({ firstName: '', lastName: 'Traoré', sex: 'm', birthDate: '14/03/1988', phone: '0707', email: 'x' });
    expect(result.success).toBe(false);
    if (result.success) return;
    const errors = fieldErrorsFromZod(result.error);
    expect(errors.firstName).toBe('Ce champ est obligatoire.');
    expect(errors.sex).toBe('Valeur non reconnue.');
    expect(errors.birthDate).toBe('Date invalide (format AAAA-MM-JJ).');
    expect(errors.phone).toContain('E.164');
    expect(errors.email).toBe('Adresse e-mail invalide.');
  });

  it('indexe les erreurs imbriquées avec des chemins pointés', () => {
    const result = signupTenantSchema.safeParse({ establishment: { slug: 'A' }, mainSite: {}, admin: { password: 'court' } });
    expect(result.success).toBe(false);
    if (result.success) return;
    const errors = fieldErrorsFromZod(result.error);
    expect(errors['establishment.slug']).toBeDefined();
    expect(errors['admin.password']).toBe('Au moins 12 caractères sont requis.');
    expect(errors['mainSite.code']).toBeDefined();
  });

  it('couvre les types et bornes génériques', () => {
    const schema = z.object({ n: z.number().min(5).max(10), s: z.string().max(3), t: z.string().min(1), arr: z.array(z.string()).min(1) });
    const result = schema.safeParse({ n: 1, s: 'abcdef', t: undefined, arr: [] });
    expect(result.success).toBe(false);
    if (result.success) return;
    const errors = fieldErrorsFromZod(result.error);
    expect(errors.n).toBe('La valeur doit être au moins 5.');
    expect(errors.s).toBe('Au plus 3 caractères sont autorisés.');
    expect(errors.t).toContain('obligatoire');
    expect(errors.arr).toContain('au moins 1');
    const big = z.number().max(2).safeParse(9);
    expect(big.success ? '' : issueMessage(big.error.issues[0]!)).toBe('La valeur doit être au plus 2.');
  });

  it('retourne un message générique pour un code inconnu', () => {
    const result = z.string().refine(() => false).safeParse('x');
    expect(result.success ? '' : issueMessage({ ...result.error.issues[0]!, message: 'Invalid input' })).toBe('Valeur invalide.');
  });

  it('loginSchema accepte un identifiant valide', () => {
    expect(loginSchema.safeParse({ tenantSlug: 'clinique-a', email: 'A@X.sn', password: 'x' }).success).toBe(true);
  });
});

describe('safeNextPath', () => {
  it.each([
    ['/patients?q=a', '/patients?q=a'],
    ['//evil.com', '/'],
    ['https://evil.com', '/'],
    ['/\\evil.com', '/'],
    ['/a\nb', '/'],
    ['', '/'],
    [null, '/'],
    [undefined, '/'],
  ])('%s -> %s', (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });
});

describe('publicValues : mots de passe de C6/C7', () => {
  it('ne renvoie jamais les mots de passe saisis', () => {
    expect(publicValues({ currentPassword: 'a', newPassword: 'b', confirmPassword: 'c', email: 'x@y.sn' })).toEqual({ email: 'x@y.sn' });
  });
});

describe('safePlatformPath', () => {
  it('accepte les chemins de la console plateforme', async () => {
    const { safePlatformPath } = await import('./forms');
    expect(safePlatformPath('/plateforme/factures?status=open')).toBe('/plateforme/factures?status=open');
    expect(safePlatformPath('/plateforme')).toBe('/plateforme');
  });
  it('refuse les chemins établissement, externes et ambigus', async () => {
    const { safePlatformPath } = await import('./forms');
    for (const bad of ['/patients', '//evil.test', 'https://evil.test', '/plateformefake', '/plateforme\\x', undefined, null, '']) {
      expect(safePlatformPath(bad)).toBe('/plateforme');
    }
  });
});
