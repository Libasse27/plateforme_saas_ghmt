/**
 * Contrat de la passerelle de paiement (docs/05 A9), implémenté par le module `payments`.
 * Les autres modules (facturation patient, abonnements SaaS) n'utilisent QUE ce contrat.
 */
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

export interface PaymentsGateway {
  initiate(input: InitiatePaymentInput): Promise<InitiatedPayment>;
  /** Re-vérification serveur à serveur auprès de l'agrégateur ; publie l'événement si l'état final change. */
  refresh(attemptId: string): Promise<{ readonly status: PaymentAttemptStatus }>;
}
