import type { MailMessage, Mailer } from './mailer';

/** Transport mémoire des tests : conserve les messages envoyés pour les inspecter. */
export class MemoryMailer implements Mailer {
  private readonly outbox: MailMessage[] = [];
  private failNext = false;

  get sent(): readonly MailMessage[] {
    return [...this.outbox];
  }

  send(message: MailMessage): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('Échec d’envoi simulé'));
    }
    this.outbox.push(message);
    return Promise.resolve();
  }

  /** Simule une panne du serveur SMTP pour le prochain envoi. */
  failOnNextSend(): void {
    this.failNext = true;
  }

  lastTo(email: string): MailMessage | undefined {
    return [...this.outbox].reverse().find((m) => m.to === email);
  }

  clear(): void {
    this.outbox.length = 0;
  }
}
