/**
 * Catalogue des événements de domaine échangés entre modules (docs/03 §6).
 * Aucun contenu clinique : identifiants, montants et statuts uniquement.
 */

export type PaymentPurpose = 'saas_invoice' | 'patient_invoice';

export interface PaymentSettledPayload {
  readonly attemptId: string;
  readonly purpose: PaymentPurpose;
  /** Tenant concerné (payeur pour une facture SaaS, établissement encaissant pour une facture patient). */
  readonly tenantId: string;
  /** Facture SaaS (platform.saas_invoices.id) ou facture patient (tenant.invoices.id). */
  readonly referenceId: string;
  /** Montant décimal en chaîne (ex. "25000.00"), jamais de flottant. */
  readonly amount: string;
  readonly currency: string;
  readonly provider: string;
  readonly providerReference: string | null;
  readonly settledAt: string;
}

export interface DomainEventMap {
  'payment.succeeded': PaymentSettledPayload;
  'payment.failed': PaymentSettledPayload & { readonly reason: string };
  'subscription.status_changed': {
    readonly tenantId: string;
    readonly subscriptionId: string;
    readonly from: string;
    readonly to: string;
    readonly at: string;
  };
}

export type DomainEventType = keyof DomainEventMap;
