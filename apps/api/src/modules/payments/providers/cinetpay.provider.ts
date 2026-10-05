import { createHash } from 'node:crypto';
import type { PaymentChannel } from '../../../common/payments/payments-gateway';
import type { Env } from '../../../infrastructure/config/env';
import {
  ProviderError,
  type CheckoutInput,
  type CheckoutSession,
  type PaymentProvider,
  type ProviderTransaction,
  type WebhookHeaders,
  type WebhookVerification,
} from '../domain/payment-provider';
import { hmacSha256Hex, safeEqualHex } from '../domain/webhook-signature';

export const CINETPAY_CODE = 'cinetpay';

/** Devises de l'API CinetPay v2 ; XOF, XAF, CDF et GNF n'ont pas de décimales. */
const SUPPORTED_CURRENCIES: ReadonlySet<string> = new Set(['XOF', 'XAF', 'CDF', 'GNF', 'USD']);
const WHOLE_NUMBER_CURRENCIES: ReadonlySet<string> = new Set(['XOF', 'XAF', 'CDF', 'GNF']);
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_DESCRIPTION_LENGTH = 200;
/** CinetPay refuse ces caractères dans le libellé. */
const FORBIDDEN_DESCRIPTION_CHARS = /[#/$_&]/g;

/** Champs signés d'une notification, dans l'ordre de la documentation CinetPay (concaténés puis HMAC-SHA256). */
const NOTIFICATION_FIELDS = [
  'cpm_site_id',
  'cpm_trans_id',
  'cpm_trans_date',
  'cpm_amount',
  'cpm_currency',
  'signature',
  'payment_method',
  'cel_phone_num',
  'cpm_phone_prefixe',
  'cpm_language',
  'cpm_version',
  'cpm_payment_config',
  'cpm_page_action',
  'cpm_custom',
  'cpm_designation',
  'cpm_error_message',
] as const;

/** Champs d'une notification qui peuvent contenir des données personnelles du payeur. */
const PERSONAL_NOTIFICATION_FIELDS: ReadonlySet<string> = new Set([
  'cel_phone_num',
  'cpm_phone_prefixe',
  'cpm_custom',
  'cpm_designation',
  'customer_name',
  'customer_surname',
  'customer_email',
  'customer_phone_number',
]);

type FetchLike = typeof fetch;

interface CinetPayResponse {
  readonly code?: string;
  readonly message?: string;
  readonly data?: {
    readonly payment_url?: string;
    readonly status?: string;
    readonly amount?: string | number;
    readonly currency?: string;
  };
}

/** Codes « échec définitif » de /payment/check (documentation CinetPay). */
const FAILED_CODES: ReadonlySet<string> = new Set(['600', '627']);
const PENDING_CODES: ReadonlySet<string> = new Set(['662', '625']);

/**
 * Adaptateur CinetPay (API checkout v2), écrit d'après la documentation publique.
 * Inactif tant que CINETPAY_API_KEY, CINETPAY_SITE_ID, CINETPAY_SECRET_KEY et CINETPAY_NOTIFY_URL ne sont pas tous définis.
 */
export class CinetPayProvider implements PaymentProvider {
  readonly code = CINETPAY_CODE;

  constructor(
    private readonly env: Env,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  isEnabled(): boolean {
    return Boolean(this.env.CINETPAY_API_KEY && this.env.CINETPAY_SITE_ID && this.env.CINETPAY_SECRET_KEY && this.env.CINETPAY_NOTIFY_URL);
  }

  supports(channel: PaymentChannel, currency: string): boolean {
    // Le paiement par carte exige l'identité complète du payeur, que la plateforme ne détient pas.
    return channel === 'mobile_money' && SUPPORTED_CURRENCIES.has(currency);
  }

  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    const body = {
      apikey: this.env.CINETPAY_API_KEY,
      site_id: this.env.CINETPAY_SITE_ID,
      transaction_id: input.providerReference,
      amount: this.wireAmount(input.amount, input.currency),
      currency: input.currency,
      description: this.cleanDescription(input.description),
      notify_url: this.env.CINETPAY_NOTIFY_URL,
      ...(this.env.CINETPAY_RETURN_URL ? { return_url: this.env.CINETPAY_RETURN_URL } : {}),
      channels: 'MOBILE_MONEY',
      lang: 'fr',
      ...(input.payerPhone ? { customer_phone_number: input.payerPhone } : {}),
    };
    const response = await this.post('/payment', body);
    const checkoutUrl = response.data?.payment_url;
    if (response.code !== '201' || !checkoutUrl) throw new ProviderError(this.code, `Création refusée (code ${response.code ?? 'inconnu'})`, 'refused');
    return { checkoutUrl, instructions: 'Validez le paiement sur la page de l’opérateur ou sur votre téléphone.' };
  }

  async getTransactionStatus(providerReference: string): Promise<ProviderTransaction> {
    const response = await this.post('/payment/check', {
      apikey: this.env.CINETPAY_API_KEY,
      site_id: this.env.CINETPAY_SITE_ID,
      transaction_id: providerReference,
    });
    const code = response.code ?? '';
    const status = response.data?.status ?? '';
    const amount = response.data?.amount === undefined ? null : String(response.data.amount);
    const currency = response.data?.currency ?? null;
    if (code === '00' && status === 'ACCEPTED') return { status: 'succeeded', amount, currency };
    if (FAILED_CODES.has(code) || status === 'REFUSED') return { status: 'failed', amount, currency };
    if (PENDING_CODES.has(code) || status === 'WAITING_FOR_CUSTOMER' || status === 'PENDING') return { status: 'pending', amount, currency };
    throw new ProviderError(this.code, `Réponse de statut inattendue (code ${code || 'absent'})`);
  }

  verifyWebhook(headers: WebhookHeaders, rawBody: Buffer): WebhookVerification {
    const secret = this.env.CINETPAY_SECRET_KEY;
    const fields = this.parseNotification(rawBody);
    const token = headers['x-token'];
    if (!secret || !fields || typeof token !== 'string') return { valid: false };
    const signed = NOTIFICATION_FIELDS.map((name) => fields[name] ?? '').join('');
    if (!safeEqualHex(token, hmacSha256Hex(secret, signed))) return { valid: false };
    const reference = fields['cpm_trans_id'];
    if (fields['cpm_site_id'] !== this.env.CINETPAY_SITE_ID || !reference) return { valid: false };
    // CinetPay n'envoie pas d'identifiant d'événement : référence + empreinte du corps (un rejeu strict est dédoublonné).
    const digest = createHash('sha256').update(rawBody).digest('hex').slice(0, 24);
    return { valid: true, eventId: `${reference}:${digest}`, providerReference: reference };
  }

  /** Champs personnels de la notification CinetPay, jamais conservés (téléphone, préfixe, données libres du payeur). */
  redactWebhookBody(rawBody: Buffer): string {
    const fields = this.parseNotification(rawBody);
    if (!fields) return '[corps illisible non conservé]';
    const kept = Object.fromEntries(Object.entries(fields).filter(([name]) => !PERSONAL_NOTIFICATION_FIELDS.has(name)));
    return JSON.stringify(kept);
  }

  private parseNotification(rawBody: Buffer): Record<string, string> | undefined {
    const text = rawBody.toString('utf8').trim();
    try {
      const entries: [string, unknown][] = text.startsWith('{')
        ? Object.entries(JSON.parse(text) as Record<string, unknown>)
        : [...new URLSearchParams(text).entries()];
      return Object.fromEntries(entries.map(([key, value]) => [key, value === null || value === undefined ? '' : String(value)]));
    } catch {
      return undefined;
    }
  }

  /** Les agrégateurs attendent un nombre JSON : seule frontière où un montant quitte la représentation décimale. */
  private wireAmount(amount: string, currency: string): number {
    const value = Number(amount);
    if (WHOLE_NUMBER_CURRENCIES.has(currency) && !Number.isInteger(value)) {
      throw new ProviderError(this.code, `Le montant doit être un entier en ${currency}`);
    }
    return value;
  }

  private cleanDescription(description: string): string {
    return description.replace(FORBIDDEN_DESCRIPTION_CHARS, '').trim().slice(0, MAX_DESCRIPTION_LENGTH);
  }

  private async post(path: string, body: Record<string, unknown>): Promise<CinetPayResponse> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.env.CINETPAY_BASE_URL}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error: unknown) {
      throw new ProviderError(this.code, `Appel impossible (${error instanceof Error ? error.name : 'erreur'})`);
    }
    const parsed = (await response.json().catch(() => undefined)) as CinetPayResponse | undefined;
    // 404 avec code métier = « transaction introuvable » (lisible) ; tout autre statut HTTP en erreur est une panne ou un refus.
    if (!parsed || typeof parsed !== 'object' || (!response.ok && !(response.status === 404 && parsed.code))) {
      // Un 4xx accompagné d'un code métier est un refus explicite ; tout le reste (5xx, corps illisible) est une panne.
      const refused = Boolean(parsed && typeof parsed === 'object' && parsed.code && response.status >= 400 && response.status < 500);
      throw new ProviderError(this.code, `Réponse invalide (HTTP ${response.status})`, refused ? 'refused' : 'technical');
    }
    return parsed;
  }
}
