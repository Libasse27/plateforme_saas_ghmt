import { Inject, Injectable } from '@nestjs/common';
import { MAILER, type Mailer } from '../../../common/mail/mailer';
import { classifySmtpError, type ClassifiedError } from '../domain/error-classification';
import { maskEmail, maskPhone } from '../domain/masking';
import { SMS_PROVIDER_TOKEN, SmsProviderError, type SmsProvider } from '../providers/sms-provider';
import type { ComposedMessage } from './message-composer';
import type { SentResult } from './delivery-recorder';
import { RecipientHasher } from './recipient-hasher';

export interface PreparedSend {
  readonly tenantId: string;
  readonly notificationId: string;
  readonly channel: 'email' | 'sms';
  /** Adresse déchiffrée EN MÉMOIRE seulement, le temps de l'envoi. */
  readonly address: string;
  readonly message: ComposedMessage;
}

export type SendOutcome = { readonly ok: true; readonly result: SentResult } | { readonly ok: false; readonly error: ClassifiedError; readonly provider: string };

/** Appel du fournisseur (e-mail ou SMS), HORS transaction. Ne journalise ni adresse ni texte. */
@Injectable()
export class ChannelSender {
  constructor(
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(SMS_PROVIDER_TOKEN) private readonly sms: SmsProvider,
    private readonly hasher: RecipientHasher,
  ) {}

  async send(prepared: PreparedSend): Promise<SendOutcome> {
    return prepared.channel === 'email' ? this.sendEmail(prepared) : this.sendSms(prepared);
  }

  private async sendEmail(prepared: PreparedSend): Promise<SendOutcome> {
    const provider = 'smtp';
    try {
      await this.mailer.send({
        to: prepared.address,
        subject: prepared.message.subject ?? '',
        text: prepared.message.text,
        ...(prepared.message.html ? { html: prepared.message.html } : {}),
      });
    } catch (error: unknown) {
      return { ok: false, error: classifySmtpError(error), provider };
    }
    return { ok: true, result: this.result(provider, null, maskEmail(prepared.address), prepared.address) };
  }

  private async sendSms(prepared: PreparedSend): Promise<SendOutcome> {
    const maskedTo = maskPhone(prepared.address);
    try {
      const { providerMessageId } = await this.sms.send({
        to: prepared.address,
        text: prepared.message.text,
        clientRef: `${prepared.tenantId}.${prepared.notificationId}`,
        maskedTo,
      });
      return { ok: true, result: this.result(this.sms.name, providerMessageId, maskedTo, prepared.address) };
    } catch (error: unknown) {
      const classified = error instanceof SmsProviderError ? { errorClass: error.errorClass, errorCode: error.errorCode } : { errorClass: 'transient' as const, errorCode: 'sms_unknown' };
      return { ok: false, error: classified, provider: this.sms.name };
    }
  }

  private result(provider: string, providerMessageId: string | null, recipientMasked: string, address: string): SentResult {
    return { provider, providerMessageId, recipientMasked, recipientHashBytes: this.hasher.hash(address) };
  }
}
