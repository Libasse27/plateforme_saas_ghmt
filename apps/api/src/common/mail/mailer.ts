/** Jeton d'injection du service d'envoi d'e-mails. */
export const MAILER = Symbol('MAILER');

export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

/**
 * Envoi d'e-mails transactionnels. Le contenu peut porter un jeton à usage unique :
 * aucune implémentation ne doit le journaliser.
 */
export interface Mailer {
  send(message: MailMessage): Promise<void>;
}
