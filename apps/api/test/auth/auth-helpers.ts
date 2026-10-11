import type { INestApplication } from '@nestjs/common';
import { generate } from 'otplib';
import request from 'supertest';
import { MAILER } from '../../src/common/mail/mailer';
import type { MemoryMailer } from '../../src/common/mail/memory-mailer';
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

export const memoryMailer = (app: INestApplication): MemoryMailer => app.get<MemoryMailer>(MAILER);

/** Code à 6 chiffres du dernier e-mail « code de vérification » envoyé à `to` (transport mémoire). */
export function lastEmailCode(app: INestApplication, to: string): string {
  const message = [...memoryMailer(app).sent].reverse().find((m) => m.to === to && /code de vérification/i.test(m.subject));
  const code = message?.text.match(/:\s(\d{6})\b/)?.[1];
  if (!code) throw new Error('Aucun code e-mail trouvé');
  return code;
}

/**
 * Démarre l'enrôlement TOTP (`setup`) comme le fait le front : hors réseau de confiance (cas des tests, sans plage déclarée),
 * un code reçu par e-mail est exigé ; sur réseau de confiance, `email-code` répond 422 et `setup` s'appelle sans code.
 */
export async function startTotpSetup(app: INestApplication, accessToken: string, email: string) {
  const send = await http(app).post(`${AUTH}/mfa/totp/email-code`).set('Authorization', `Bearer ${accessToken}`).set('X-Forwarded-For', distinctClientIp());
  const body = send.status === 202 ? { emailCode: lastEmailCode(app, email) } : {};
  return http(app).post(`${AUTH}/mfa/totp/setup`).set('Authorization', `Bearer ${accessToken}`).set('X-Forwarded-For', distinctClientIp()).send(body);
}

/** Enrôle un TOTP via l'API réelle ; retourne le secret et les codes de secours. */
export async function enrollTotp(app: INestApplication, accessToken: string, email: string): Promise<{ secret: string; backupCodes: string[] }> {
  const setup = await startTotpSetup(app, accessToken, email).then((res) => {
    expectOk(res.status);
    return res;
  });
  const secret = setup.body.data.secret as string;
  const activate = await http(app)
    .post(`${AUTH}/mfa/totp/activate`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ code: await totpCode(secret) })
    .expect(200);
  return { secret, backupCodes: activate.body.data.backupCodes as string[] };
}

function expectOk(status: number): void {
  if (status !== 200) throw new Error(`setup TOTP : statut ${status}`);
}

export function bearer(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}
