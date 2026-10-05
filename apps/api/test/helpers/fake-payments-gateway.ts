import { randomUUID } from 'node:crypto';
import type { InitiatePaymentInput, InitiatedPayment, PaymentsGateway } from '../../src/common/payments/payments-gateway';

/**
 * Double du contrat `PaymentsGateway` : enregistre les demandes d'initiation sans appeler de fournisseur.
 * Les tests publient eux-mêmes `payment.succeeded` sur le `DomainEventBus` (aucune dépendance à l'implémentation du module payments).
 */
export class FakePaymentsGateway implements PaymentsGateway {
  readonly initiated: InitiatePaymentInput[] = [];
  private readonly byKey = new Map<string, InitiatedPayment>();

  initiate(input: InitiatePaymentInput): Promise<InitiatedPayment> {
    this.initiated.push(input);
    const known = this.byKey.get(input.idempotencyKey);
    if (known) return Promise.resolve(known);
    const payment: InitiatedPayment = {
      attemptId: randomUUID(),
      status: 'pending',
      provider: 'sandbox',
      checkoutUrl: `https://sandbox.test/pay/${input.referenceId}`,
      instructions: 'Validez le paiement sur votre téléphone.',
    };
    this.byKey.set(input.idempotencyKey, payment);
    return Promise.resolve(payment);
  }

  refresh(): Promise<{ readonly status: 'pending' }> {
    return Promise.resolve({ status: 'pending' });
  }

  cancel(): Promise<{ readonly status: 'cancelled' }> {
    return Promise.resolve({ status: 'cancelled' });
  }
}
