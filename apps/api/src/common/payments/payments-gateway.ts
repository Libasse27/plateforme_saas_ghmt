/**
 * Contrat de la passerelle de paiement (docs/05 A9), implémenté par le module `payments`.
 * Les autres modules (facturation patient, abonnements SaaS) n'utilisent QUE ce contrat.
 */
import { DomainError } from '../errors/domain-error';
import type { PaymentPurpose } from '../events/domain-events';

export const PAYMENTS_GATEWAY = Symbol('PAYMENTS_GATEWAY');

export type PaymentChannel = 'mobile_money' | 'card';
export type PaymentAttemptStatus = 'pending' | 'succeeded' | 'failed' | 'cancelled';

export interface InitiatePaymentInput {
  readonly purpose: PaymentPurpose;
  readonly tenantId: string;
  readonly referenceId: string;
  /** Montant décimal en chaîne, ex. "15000.00". */
  readonly amount: string;
  readonly currency: string;
  readonly channel: PaymentChannel;
  /** Numéro E.164 du payeur (Mobile Money). Jamais journalisé en clair. */
  readonly payerPhone?: string;
  /** Libellé court sans donnée de santé (ex. « Facture FAC-2026-000123 »). */
  readonly description: string;
  /** Clé d'idempotence fournie par l'appelant : une même clé renvoie la même tentative. */
  readonly idempotencyKey: string;
}

export interface InitiatedPayment {
  readonly attemptId: string;
  readonly status: PaymentAttemptStatus;
  readonly provider: string;
  /** URL de paiement hébergée par l'agrégateur, ou null pour un push USSD. */
  readonly checkoutUrl: string | null;
  /** Consigne affichable (ex. « Validez le paiement sur votre téléphone »). */
  readonly instructions: string | null;
}

/**
 * Fournisseur injoignable ou refusant la demande (code unifié `payment_provider_unavailable`).
 * `attemptRetained` : échec TECHNIQUE, la tentative `attemptId` reste `pending` et le job de relance l'interroge ;
 * sinon (refus explicite ou aucun fournisseur) la tentative est `failed` ou n'existe pas.
 */
export class PaymentProviderUnavailableError extends DomainError {
  constructor(
    readonly attemptId: string | null,
    readonly attemptRetained: boolean,
    status = 502,
  ) {
    super(
      'payment_provider_unavailable',
      status,
      status === 503 ? 'Service Unavailable' : 'Bad Gateway',
      attemptRetained ? 'Le fournisseur de paiement n’a pas répondu : le paiement sera vérifié automatiquement.' : 'Le fournisseur de paiement est momentanément indisponible.',
    );
  }
}

export interface PaymentsGateway {
  initiate(input: InitiatePaymentInput): Promise<InitiatedPayment>;
  /** Re-vérification serveur à serveur auprès de l'agrégateur ; publie l'événement si l'état final change. */
  refresh(attemptId: string): Promise<{ readonly status: PaymentAttemptStatus }>;
  /**
   * Abandon par l'encaisseur : une tentative encore en attente passe à `cancelled` sans événement ; un règlement déjà
   * final est conservé (le statut courant est renvoyé). Un succès confirmé plus tard reste enregistrable.
   */
  cancel(attemptId: string): Promise<{ readonly status: PaymentAttemptStatus }>;
}
