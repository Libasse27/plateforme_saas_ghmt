import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { SignupTenantInput } from '@ghmt/shared';
import { MAILER } from '../../src/common/mail/mailer';
import type { MailMessage } from '../../src/common/mail/mailer';
import type { MemoryMailer } from '../../src/common/mail/memory-mailer';
import { PlatformDb } from '../../src/infrastructure/prisma/platform-db.service';
import { BackgroundTasks } from '../../src/common/tasks/background-tasks';
import { AUTH, distinctClientIp, http } from '../auth/auth-helpers';
import { signupInput } from '../helpers/fixtures';

const LINK_PATTERN = /\/inscription\/confirmer\/([0-9a-f-]{36}\.[A-Za-z0-9_-]+)/;

export function uniqueSlug(prefix = 'ops'): string {
  return `${prefix}-${randomBytes(4).toString('hex')}`;
}

export function mailerOf(app: INestApplication): MemoryMailer {
  return app.get(MAILER) as MemoryMailer;
}

/** Jeton extrait du lien d'un e-mail de vérification. */
export function tokenFromMail(mail: MailMessage | undefined): string {
  const match = LINK_PATTERN.exec(mail?.text ?? '');
  if (!match?.[1]) throw new Error('Aucun lien de confirmation dans l’e-mail');
  return match[1];
}

export function postSignup(app: INestApplication, input: SignupTenantInput) {
  return http(app).post(`${AUTH}/signup`).set('X-Forwarded-For', distinctClientIp()).send(input);
}

export interface SignedUpTenant {
  readonly input: SignupTenantInput;
  readonly slug: string;
  readonly tenantId: string;
  readonly token: string;
}

/** Inscription complète (201) et récupération du jeton de l'e-mail de vérification. */
export async function signUp(app: INestApplication, slug: string = uniqueSlug()): Promise<SignedUpTenant> {
  const input = signupInput(slug);
  mailerOf(app).clear();
  const res = await postSignup(app, input).expect(201);
  return { input, slug, tenantId: res.body.data.tenantId as string, token: tokenFromMail(mailerOf(app).lastTo(input.admin.email)) };
}

export function postVerify(app: INestApplication, token: string) {
  return http(app).post(`${AUTH}/signup/verify`).set('X-Forwarded-For', distinctClientIp()).send({ token });
}

export function postResend(app: INestApplication, body: { tenantSlug: string; email: string }, ip: string = distinctClientIp()) {
  return http(app).post(`${AUTH}/signup/resend`).set('X-Forwarded-For', ip).send(body);
}

/** Attend la fin des traitements exécutés après la réponse HTTP. */
export function drainDeferred(app: INestApplication): Promise<void> {
  return app.get(BackgroundTasks).drain();
}

export async function tenantRow(app: INestApplication, tenantId: string) {
  return app.get(PlatformDb).run((tx) => tx.tenant.findUniqueOrThrow({ where: { id: tenantId } }));
}
