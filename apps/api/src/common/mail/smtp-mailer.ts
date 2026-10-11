import { createTransport, type Transporter } from 'nodemailer';
import type { Env } from '../../infrastructure/config/env';
import type { MailMessage, Mailer } from './mailer';

const CONNECTION_TIMEOUT_MS = 5_000;
const IMPLICIT_TLS_PORT = 465;
/** Environnements où un relais local sans TLS (Mailpit) est admis. */
const PLAINTEXT_ALLOWED: ReadonlySet<Env['NODE_ENV']> = new Set(['development', 'test']);

/**
 * Envoi via SMTP (Mailpit en développement, relais SMTP en production). Hors développement et test, le chiffrement est
 * obligatoire : TLS implicite sur 465, STARTTLS exigé sinon (les liens de réinitialisation ne circulent jamais en clair).
 */
export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(env: Pick<Env, 'NODE_ENV' | 'SMTP_HOST' | 'SMTP_PORT' | 'MAIL_FROM'>) {
    this.from = env.MAIL_FROM;
    const secure = env.SMTP_PORT === IMPLICIT_TLS_PORT;
    this.transport = createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure,
      requireTLS: !secure && !PLAINTEXT_ALLOWED.has(env.NODE_ENV),
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      greetingTimeout: CONNECTION_TIMEOUT_MS,
      socketTimeout: CONNECTION_TIMEOUT_MS * 2,
    });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
    });
  }
}
