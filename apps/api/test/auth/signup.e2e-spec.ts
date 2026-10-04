import type { INestApplication } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_PASSWORD, signupInput } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { AUTH, bearer, http, postLogin } from './auth-helpers';

describe('auth : inscription d’un établissement puis connexion', () => {
  let app: INestApplication;
  const slug = `signup-${randomBytes(4).toString('hex')}`;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('signup crée l’établissement (201, sans connexion automatique) puis login et /me fonctionnent', async () => {
    const input = signupInput(slug);

    const signup = await http(app).post(`${AUTH}/signup`).send(input).expect(201);
    const login = await postLogin(app, slug, input.admin.email, FIXTURE_PASSWORD).expect(200);
    const me = await http(app).get(`${AUTH}/me`).set(bearer(login.body.data.accessToken)).expect(200);

    expect(signup.body.data).toEqual({ tenantId: expect.any(String), slug });
    expect(signup.body.data).not.toHaveProperty('accessToken');
    expect(login.body.data).toMatchObject({ expiresIn: 900, mfaEnrolled: false, mfaRequired: true });
    expect(me.body.data.user).toMatchObject({ email: input.admin.email, fullName: 'Admin Test', locale: 'fr' });
    expect(me.body.data.tenant).toEqual({
      id: signup.body.data.tenantId,
      slug,
      name: `Clinique ${slug}`,
      timezone: 'Africa/Dakar',
      countryCode: 'SN',
      baseCurrency: 'XOF',
    });
    expect(me.body.data.user.mustChangePassword).toBe(false);
    expect(me.body.data.permissions).toContain('iam:user:read');
    expect(me.body.data.modules).toEqual(expect.arrayContaining(['appointments']));
    expect(me.body.data.mfa).toEqual({ enrolled: false, verified: false, required: true });
  });

  it('refuse un identifiant d’établissement déjà pris (409)', async () => {
    const res = await http(app).post(`${AUTH}/signup`).send(signupInput(slug)).expect(409);

    expect(res.body).toMatchObject({ status: 409, code: 'slug_taken' });
  });

  it('refuse un corps invalide (422) avec le détail des champs', async () => {
    const input = signupInput(`signup-${randomBytes(4).toString('hex')}`);
    const invalid = { ...input, admin: { ...input.admin, password: 'court' } };

    const res = await http(app).post(`${AUTH}/signup`).send(invalid).expect(422);

    expect(res.body.code).toBe('validation_failed');
    expect(res.body.errors.map((e: { path: string }) => e.path)).toContain('admin.password');
  });
});
