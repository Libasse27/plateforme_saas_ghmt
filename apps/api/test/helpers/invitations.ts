import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { MAILER } from '../../src/common/mail/mailer';
import type { MemoryMailer } from '../../src/common/mail/memory-mailer';
import { distinctClientIp } from '../auth/auth-helpers';
import { FIXTURE_PASSWORD } from './fixtures';

const LINK_PATTERN = /\/invitation\/([A-Za-z0-9._-]+)/;

/** Transport mémoire de l'application de test (NODE_ENV=test). */
export function mailerOf(app: INestApplication): MemoryMailer {
  return app.get<MemoryMailer>(MAILER);
}

/** Jeton d'invitation extrait du dernier e-mail reçu par `email` (le jeton ne transite que par ce lien). */
export function invitationTokenFor(app: INestApplication, email: string): string {
  const message = mailerOf(app).lastTo(email);
  if (!message) throw new Error(`Aucun e-mail pour ${email}`);
  const token = LINK_PATTERN.exec(message.text)?.[1];
  if (!token) throw new Error('Lien d’invitation introuvable dans l’e-mail');
  return token;
}

/** Accepte l'invitation reçue par `email` en choisissant un mot de passe (flux public réel). */
export async function acceptInvitationFor(app: INestApplication, email: string, password: string = FIXTURE_PASSWORD): Promise<void> {
  await request(app.getHttpServer())
    .post(`/api/v1/auth/invitations/${invitationTokenFor(app, email)}/accept`)
    // Adresse cliente distincte : le quota par IP des routes publiques ne gêne pas les scénarios.
    .set('X-Forwarded-For', distinctClientIp())
    .send({ password })
    .expect(204);
}
