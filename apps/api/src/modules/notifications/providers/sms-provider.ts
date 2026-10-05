import type { SmsProviderName } from '@ghmt/shared';
import type { ErrorClass } from '../domain/error-classification';

/** Jeton d'injection du fournisseur SMS actif (docs/10 D5). */
export const SMS_PROVIDER_TOKEN = Symbol('SMS_PROVIDER');

export interface SmsSendRequest {
  /** Numéro E.164 en clair : jamais journalisé, jamais stocké (docs/10 D6). */
  readonly to: string;
  readonly text: string;
  /** `<tenantId>.<notificationId>` : corrèle l'accusé de réception. */
  readonly clientRef: string;
  /** Numéro masqué, pour les copies de développement. */
  readonly maskedTo: string;
}

export interface SmsSendResult {
  readonly providerMessageId: string | null;
}

/** Échec d'envoi classé ; le message ne porte jamais de donnée personnelle ni de secret. */
export class SmsProviderError extends Error {
  constructor(
    readonly errorClass: ErrorClass,
    readonly errorCode: string,
  ) {
    super(`Échec du fournisseur SMS : ${errorCode}`);
    this.name = 'SmsProviderError';
  }
}

export interface SmsProvider {
  readonly name: SmsProviderName;
  send(request: SmsSendRequest): Promise<SmsSendResult>;
}

/** `SMS_PROVIDER=none` : aucun SMS ne part (les messages sont supprimés `provider_unavailable`, avec repli e-mail). */
export class UnavailableSmsProvider implements SmsProvider {
  readonly name = 'none' as const;

  send(): Promise<SmsSendResult> {
    return Promise.reject(new SmsProviderError('permanent_config', 'provider_unavailable'));
  }
}
