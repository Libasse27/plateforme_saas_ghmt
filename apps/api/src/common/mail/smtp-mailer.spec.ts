import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SmtpMailer } from './smtp-mailer';

const { sendMail, createTransport } = vi.hoisted(() => {
  const send = vi.fn();
  return { sendMail: send, createTransport: vi.fn(() => ({ sendMail: send })) };
});
vi.mock('nodemailer', () => ({ createTransport }));

describe('SmtpMailer', () => {
  beforeEach(() => {
    sendMail.mockReset();
    createTransport.mockClear();
  });

  it('configure le transport SMTP depuis l’environnement (Mailpit : localhost:1025, sans TLS)', () => {
    new SmtpMailer({ SMTP_HOST: 'localhost', SMTP_PORT: 1025, MAIL_FROM: 'GHMT <no-reply@ghmt.local>' });

    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ host: 'localhost', port: 1025, secure: false }));
  });

  it('active TLS implicite sur le port 465', () => {
    new SmtpMailer({ SMTP_HOST: 'smtp.example.org', SMTP_PORT: 465, MAIL_FROM: 'a@b.c' });

    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ secure: true }));
  });

  it('envoie le message avec l’expéditeur configuré, en texte et en HTML si fourni', async () => {
    sendMail.mockResolvedValue({});
    const mailer = new SmtpMailer({ SMTP_HOST: 'localhost', SMTP_PORT: 1025, MAIL_FROM: 'GHMT <no-reply@ghmt.local>' });

    await mailer.send({ to: 'awa@test.sn', subject: 'Sujet', text: 'texte', html: '<p>texte</p>' });
    await mailer.send({ to: 'awa@test.sn', subject: 'Sujet', text: 'texte seul' });

    expect(sendMail).toHaveBeenNthCalledWith(1, { from: 'GHMT <no-reply@ghmt.local>', to: 'awa@test.sn', subject: 'Sujet', text: 'texte', html: '<p>texte</p>' });
    expect(sendMail.mock.calls[1]![0]).not.toHaveProperty('html');
  });

  it('propage l’échec du serveur SMTP', async () => {
    sendMail.mockRejectedValue(new Error('ECONNREFUSED'));
    const mailer = new SmtpMailer({ SMTP_HOST: 'localhost', SMTP_PORT: 1025, MAIL_FROM: 'a@b.c' });

    await expect(mailer.send({ to: 'x@y.z', subject: 's', text: 't' })).rejects.toThrow('ECONNREFUSED');
  });
});
