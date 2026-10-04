import type { INestApplication } from '@nestjs/common';
import { generate } from 'otplib';
import request from 'supertest';
import { FIXTURE_PASSWORD, type TenantFixture } from '../helpers/fixtures';

export const AUTH = '/api/v1/auth';

export interface LoginBody {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
  readonly mfaEnrolled: boolean;
  readonly mfaRequired: boolean;
}

export function http(app: INestApplication): ReturnType<typeof request> {
  return request(app.getHttpServer());
}

export const TEST_USER_AGENT = 'vitest-e2e/1.0';
let nextClientId = 1;

/** Adresse cliente distincte par appel (trust proxy) : isole le quota par IP du scénario testé. */
export function distinctClientIp(): string {
  nextClientId += 1;
  return `10.${(nextClientId >> 16) & 255}.${(nextClientId >> 8) & 255}.${nextClientId & 255}`;
}

export function postLogin(app: INestApplication, tenantSlug: string, email: string, password: string = FIXTURE_PASSWORD) {
  return http(app)
    .post(`${AUTH}/login`)
    .set('X-Forwarded-For', distinctClientIp())
    .set('User-Agent', TEST_USER_AGENT)
    .send({ tenantSlug, email, password });
}

export function postMfaVerify(app: INestApplication, challengeId: string, code: string) {
  return http(app).post(`${AUTH}/mfa/verify`).set('X-Forwarded-For', distinctClientIp()).send({ challengeId, code });
}

/** Connexion réussie attendue (sans MFA) : retourne les données de l'enveloppe. */
export async function loginOk(app: INestApplication, tenant: Pick<TenantFixture, 'slug'>, email: string): Promise<LoginBody> {
  const res = await postLogin(app, tenant.slug, email).expect(200);
  return res.body.data as LoginBody;
}

/** Code TOTP d'un instant simulé : décalage en secondes par rapport à l'horloge du serveur. */
export function totpCode(secret: string, offsetSeconds = 0): Promise<string> {
  return generate({ secret, epoch: Math.floor(Date.now() / 1000) + offsetSeconds });
}

/** Enrôle un TOTP via l'API réelle ; retourne le secret et les codes de secours. */
export async function enrollTotp(app: INestApplication, accessToken: string): Promise<{ secret: string; backupCodes: string[] }> {
  const setup = await http(app).post(`${AUTH}/mfa/totp/setup`).set('Authorization', `Bearer ${accessToken}`).expect(200);
  const secret = setup.body.data.secret as string;
  const activate = await http(app)
    .post(`${AUTH}/mfa/totp/activate`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ code: await totpCode(secret) })
    .expect(200);
  return { secret, backupCodes: activate.body.data.backupCodes as string[] };
}

export function bearer(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}
