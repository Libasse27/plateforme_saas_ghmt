/**
 * Schémas Zod propres au module payments.
 * Chaque équipe de module n'édite que son propre fichier ; les schémas communs restent dans ./index.ts.
 */
import { z } from 'zod';
import { uuid } from './primitives';

export const PAYMENT_PURPOSES = ['saas_invoice', 'patient_invoice'] as const;
export const PAYMENT_CHANNELS = ['mobile_money', 'card'] as const;
export const PAYMENT_ATTEMPT_STATUSES = ['pending', 'succeeded', 'failed', 'cancelled'] as const;
export type PaymentAttemptStatusValue = (typeof PAYMENT_ATTEMPT_STATUSES)[number];

/** Montant décimal en chaîne (jamais de flottant), 2 décimales au plus : "25000", "25000.50". */
export const MONEY_PATTERN = /^\d{1,16}(\.\d{1,2})?$/;
export const moneyAmount = z.string().regex(MONEY_PATTERN, 'montant décimal en chaîne, ex. "25000.00"');
export const positiveMoneyAmount = moneyAmount.refine((value) => /[1-9]/.test(value), 'le montant doit être strictement positif');

/** Code de devise ISO 4217 (XOF, XAF, EUR…). */
export const currencyCode = z.string().regex(/^[A-Z]{3}$/, 'devise ISO 4217 en majuscules');

/** Simulation d'une issue de paiement par le fournisseur sandbox (développement et tests uniquement). */
export const sandboxSimulationSchema = z.object({
  attemptId: uuid,
  outcome: z.enum(['success', 'failure']),
});
export type SandboxSimulationInput = z.infer<typeof sandboxSimulationSchema>;

/** Vue d'une tentative de paiement renvoyée au web (sans donnée de santé ni numéro de téléphone). */
export interface PaymentCheckoutView {
  readonly attemptId: string;
  readonly status: PaymentAttemptStatusValue;
  readonly provider: string;
  readonly checkoutUrl: string | null;
  readonly instructions: string | null;
}
