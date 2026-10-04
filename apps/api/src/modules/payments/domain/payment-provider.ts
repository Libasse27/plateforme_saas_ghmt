import type { PaymentChannel } from '../../../common/payments/payments-gateway';

export type ProviderTransactionStatus = 'pending' | 'succeeded' | 'failed';

export interface CheckoutInput {
  /** Notre référence de transaction, transmise à l'agrégateur (retrouvée dans ses webhooks). */
  readonly providerReference: string;
  /** Montant décimal en chaîne ("15000.00"). */
  readonly amount: string;
  readonly currency: string;
  readonly channel: PaymentChannel;
  /** Libellé sans donnée de santé. */
  readonly description: string;
  /** Numéro E.164 du payeur, transmis tel quel à l'agrégateur et jamais conservé. */
  readonly payerPhone?: string;
}

export interface CheckoutSession {
  readonly checkoutUrl: string | null;
  readonly instructions: string | null;
}

export interface ProviderTransaction {
  readonly status: ProviderTransactionStatus;
  /** Montant et devise constatés par l'agrégateur (comparés exactement à la tentative). */
  readonly amount: string | null;
  readonly currency: string | null;
}

export type WebhookVerification =
  | { readonly valid: false }
  | { readonly valid: true; readonly eventId: string; readonly providerReference: string };

export type WebhookHeaders = Readonly<Record<string, string | string[] | undefined>>;

/** Abstraction des agrégateurs de paiement (docs/05 A9). Le webhook n'est jamais cru seul : le statut est re-vérifié. */
export interface PaymentProvider {
  readonly code: string;
  /** Faux si le fournisseur n'est pas configuré (adaptateur inactif) ou interdit dans l'environnement. */
  isEnabled(): boolean;
  supports(channel: PaymentChannel, currency: string): boolean;
  createCheckout(input: CheckoutInput): Promise<CheckoutSession>;
  /** Re-vérification serveur à serveur du statut de la transaction. */
  getTransactionStatus(providerReference: string): Promise<ProviderTransaction>;
  /** Authenticité du webhook (signature en temps constant) et extraction de l'identifiant d'événement et de la référence. */
  verifyWebhook(headers: WebhookHeaders, rawBody: Buffer): WebhookVerification;
}

/** Erreur d'appel à un agrégateur (réseau, statut HTTP, réponse inattendue). Le message ne contient jamais de secret. */
export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
