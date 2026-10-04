import { z } from 'zod';
import type { PaymentChannel } from '../../../common/payments/payments-gateway';
import type { Env } from '../../../infrastructure/config/env';
import type { PlatformDb } from '../../../infrastructure/prisma/platform-db.service';
import type {
  CheckoutInput,
  CheckoutSession,
  PaymentProvider,
  ProviderTransaction,
  WebhookHeaders,
  WebhookVerification,
} from '../domain/payment-provider';
import { hmacSha256Hex, safeEqualHex } from '../domain/webhook-signature';

export const SANDBOX_CODE = 'sandbox';
export const SANDBOX_SIGNATURE_HEADER = 'x-sandbox-signature';
const SANDBOX_SECRET_CONTEXT = 'ghmt:payments:sandbox-webhook';

const sandboxEventSchema = z.object({
  eventId: z.string().min(1).max(100),
  providerReference: z.string().min(1).max(100),
  status: z.enum(['succeeded', 'failed']),
});
export type SandboxEvent = z.infer<typeof sandboxEventSchema>;

/**
 * Fournisseur simulé (développement et tests) : se comporte comme un agrégateur réel de bout en bout.
 * Le « côté fournisseur » est la table `platform.sandbox_transactions` ; ses webhooks sont signés en HMAC-SHA256
 * et traversent le même pipeline que ceux de CinetPay (signature, re-vérification, montant/devise, idempotence).
 * Actif seulement si PAYMENTS_SANDBOX_ENABLED (toujours faux en production).
 */
export class SandboxProvider implements PaymentProvider {
  readonly code = SANDBOX_CODE;
  private readonly secret: string;

  constructor(
    private readonly env: Env,
    private readonly db: PlatformDb,
  ) {
    // Secret dérivé de la configuration : aucune variable supplémentaire à gérer pour un simulateur.
    this.secret = hmacSha256Hex(env.JWT_ACCESS_SECRET, SANDBOX_SECRET_CONTEXT);
  }

  isEnabled(): boolean {
    return this.env.PAYMENTS_SANDBOX_ENABLED && this.env.NODE_ENV !== 'production';
  }

  supports(_channel: PaymentChannel, _currency: string): boolean {
    return true;
  }

  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    await this.db.run((tx) =>
      tx.sandboxTransaction.create({ data: { providerReference: input.providerReference, amount: input.amount, currency: input.currency } }),
    );
    return {
      checkoutUrl: `${this.env.WEB_URL}/sandbox/paiement/${input.providerReference}`,
      instructions:
        input.channel === 'mobile_money'
          ? 'Paiement simulé : validez la demande sur l’écran de simulation (aucun débit réel).'
          : 'Paiement simulé : confirmez sur la page de simulation (aucun débit réel).',
    };
  }

  async getTransactionStatus(providerReference: string): Promise<ProviderTransaction> {
    const row = await this.db.run((tx) => tx.sandboxTransaction.findUnique({ where: { providerReference } }));
    if (!row) return { status: 'pending', amount: null, currency: null };
    return { status: row.status as ProviderTransaction['status'], amount: row.amount.toFixed(2), currency: row.currency };
  }

  verifyWebhook(headers: WebhookHeaders, rawBody: Buffer): WebhookVerification {
    const signature = headers[SANDBOX_SIGNATURE_HEADER];
    if (typeof signature !== 'string' || !safeEqualHex(signature, this.sign(rawBody))) return { valid: false };
    const event = this.parseEvent(rawBody);
    return event ? { valid: true, eventId: event.eventId, providerReference: event.providerReference } : { valid: false };
  }

  /** Signature d'un corps de webhook (utilisée par le simulateur pour émettre ses propres notifications). */
  sign(rawBody: Buffer): string {
    return hmacSha256Hex(this.secret, rawBody);
  }

  /** Fait évoluer la transaction « chez le fournisseur » : l'étape que l'utilisateur ferait sur son téléphone. */
  async completeRemote(providerReference: string, status: 'succeeded' | 'failed'): Promise<boolean> {
    const result = await this.db.run((tx) =>
      tx.sandboxTransaction.updateMany({ where: { providerReference, status: 'pending' }, data: { status } }),
    );
    return result.count === 1;
  }

  private parseEvent(rawBody: Buffer): SandboxEvent | undefined {
    try {
      const parsed = sandboxEventSchema.safeParse(JSON.parse(rawBody.toString('utf8')));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }
}
