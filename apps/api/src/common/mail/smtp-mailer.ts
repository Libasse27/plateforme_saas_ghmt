import { createTransport, type Transporter } from 'nodemailer';
import type { Env } from '../../infrastructure/config/env';
import type { MailMessage, Mailer } from './mailer';

const CONNECTION_TIMEOUT_MS = 5_000;

/** Envoi via SMTP (Mailpit en développement, relais SMTP en production). */
export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(env: Pick<Env, 'SMTP_HOST' | 'SMTP_PORT' | 'MAIL_FROM'>) {
    this.from = env.MAIL_FROM;
    this.transport = createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
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
