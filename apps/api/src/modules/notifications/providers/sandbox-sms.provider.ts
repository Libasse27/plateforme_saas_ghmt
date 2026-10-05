import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { Mailer } from '../../../common/mail/mailer';
import type { SmsProvider, SmsProviderError, SmsSendRequest, SmsSendResult } from './sms-provider';

export interface SandboxSms {
  readonly to: string;
  readonly text: string;
  readonly clientRef: string;
  readonly providerMessageId: string;
}

export interface SandboxMailCopy {
  readonly mailer: Mailer;
  readonly mailbox: string;
}

/**
 * Fournisseur SMS simulé (docs/10 D5) : conserve les messages en mémoire ; en développement, une copie part vers Mailpit
 * (sujet « SMS → numéro masqué »). Interdit en production (refusé par la configuration). Les pannes programmées servent
 * aux tests des retries.
 */
export class SandboxSmsProvider implements SmsProvider {
  readonly name = 'sandbox' as const;
  private readonly logger = new Logger(SandboxSmsProvider.name);
  private readonly store: SandboxSms[] = [];
  private readonly failures: SmsProviderError[] = [];

  constructor(private readonly copy?: SandboxMailCopy) {}

  get messages(): readonly SandboxSms[] {
    return [...this.store];
  }

  /** Le prochain envoi échoue avec cette erreur (file : une panne par envoi). */
  failNext(error: SmsProviderError): void {
    this.failures.push(error);
  }

  clear(): void {
    this.store.length = 0;
    this.failures.length = 0;
  }

  async send(request: SmsSendRequest): Promise<SmsSendResult> {
    const failure = this.failures.shift();
    if (failure) throw failure;
    const providerMessageId = `sbx-${randomUUID()}`;
    this.store.push({ to: request.to, text: request.text, clientRef: request.clientRef, providerMessageId });
    await this.copyToMailbox(request);
    return { providerMessageId };
  }

  private async copyToMailbox(request: SmsSendRequest): Promise<void> {
    if (!this.copy) return;
    try {
      await this.copy.mailer.send({ to: this.copy.mailbox, subject: `SMS → ${request.maskedTo}`, text: request.text });
    } catch {
      // La copie de développement est facultative : son échec ne change pas le résultat de l'envoi simulé.
      this.logger.warn('Copie du SMS simulé vers la boîte de développement impossible');
    }
  }
}
