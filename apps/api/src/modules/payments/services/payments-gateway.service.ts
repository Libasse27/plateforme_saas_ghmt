import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { DomainError, type FieldIssue } from '../../../common/errors/domain-error';
import { FieldCrypto } from '../../../common/crypto/field-crypto.service';
import { moneyEquals, parseMoney } from '../../../common/money/money';
import {
  PaymentProviderUnavailableError,
  type InitiatePaymentInput,
  type InitiatedPayment,
  type PaymentAttemptStatus,
  type PaymentsGateway,
} from '../../../common/payments/payments-gateway';
import { isUuid } from '../../../common/pipes/uuid.pipe';
import { ENV, type Env } from '../../../infrastructure/config/env';
import { PlatformDb } from '../../../infrastructure/prisma/platform-db.service';
import { ProviderError, type PaymentProvider } from '../domain/payment-provider';
import { resolveProviderOrder } from '../domain/payment-router';
import { FAILURE_REASONS } from '../payments.constants';
import { ProviderRegistry } from '../providers/provider-registry';
import { PaymentsRepository, type PaymentAttemptRow } from '../repositories/payments.repository';
import { PaymentSettlementService } from './payment-settlement.service';

const MONEY_PATTERN = /^\d{1,16}(\.\d{1,2})?$/;
const PHONE_PATTERN = /^\+[1-9]\d{6,14}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const MIN_IDEMPOTENCY_KEY_LENGTH = 8;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 200;
const REFERENCE_PREFIX = 'GH';
const REFERENCE_RANDOM_BYTES = 11;
const SERVICE_UNAVAILABLE = 503;

/** Implémentation du contrat `PaymentsGateway` : tentatives, routage, repli de fournisseur, idempotence. */
@Injectable()
export class PaymentsGatewayService implements PaymentsGateway {
  private readonly logger = new Logger(PaymentsGatewayService.name);

  constructor(
    private readonly db: PlatformDb,
    private readonly repo: PaymentsRepository,
    private readonly providers: ProviderRegistry,
    private readonly settlement: PaymentSettlementService,
    private readonly crypto: FieldCrypto,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async initiate(input: InitiatePaymentInput): Promise<InitiatedPayment> {
    this.validate(input);
    const amount = parseMoney(input.amount);
    const existing = await this.db.run((tx) => this.repo.findByIdempotencyKey(tx, input.idempotencyKey));
    if (existing) return this.replay(existing, input, amount);

    const candidates = await this.candidates(input);
    if (candidates.length === 0) {
      throw new PaymentProviderUnavailableError(null, false, SERVICE_UNAVAILABLE);
    }
    // Une seule tentative en attente par facture SaaS : une nouvelle demande abandonne la précédente (un succès tardif reste enregistrable).
    if (input.purpose === 'saas_invoice') await this.abandonPendingSiblings(input);
    const providerReference = `${REFERENCE_PREFIX}${randomBytes(REFERENCE_RANDOM_BYTES).toString('hex')}`;
    const attempt = await this.createAttempt(input, amount, candidates[0]!.code, providerReference);
    if (attempt.replayOf) return this.replay(attempt.replayOf, input, amount);
    return this.startCheckout(attempt.row, input, candidates);
  }

  async refresh(attemptId: string): Promise<{ readonly status: PaymentAttemptStatus }> {
    if (!isUuid(attemptId)) throw DomainError.notFound('Tentative de paiement');
    const attempt = await this.db.run((tx) => this.repo.findById(tx, attemptId));
    if (!attempt) throw DomainError.notFound('Tentative de paiement');
    try {
      const outcome = await this.settlement.verifyAndSettle(attempt);
      return { status: outcome };
    } catch (error: unknown) {
      if (error instanceof DomainError) throw error;
      this.logger.warn({ attemptId, provider: attempt.provider }, 'Re-vérification impossible auprès du fournisseur');
      throw new PaymentProviderUnavailableError(attemptId, true);
    }
  }

  async cancel(attemptId: string): Promise<{ readonly status: PaymentAttemptStatus }> {
    if (!isUuid(attemptId)) throw DomainError.notFound('Tentative de paiement');
    const attempt = await this.db.run((tx) => this.repo.findById(tx, attemptId));
    if (!attempt) throw DomainError.notFound('Tentative de paiement');
    return { status: await this.settlement.cancel(attempt) };
  }

  private validate(input: InitiatePaymentInput): void {
    const issues: FieldIssue[] = [];
    const check = (ok: boolean, path: string, message: string): void => {
      if (!ok) issues.push({ path, code: 'invalid', message });
    };
    check(isUuid(input.tenantId), 'tenantId', 'Identifiant de tenant invalide.');
    check(isUuid(input.referenceId), 'referenceId', 'Identifiant de référence invalide.');
    check(MONEY_PATTERN.test(input.amount) && /[1-9]/.test(input.amount), 'amount', 'Montant décimal strictement positif attendu.');
    check(CURRENCY_PATTERN.test(input.currency), 'currency', 'Devise ISO 4217 en majuscules attendue.');
    check(input.description.trim().length > 0 && input.description.length <= MAX_DESCRIPTION_LENGTH, 'description', 'Libellé de 1 à 200 caractères attendu.');
    check(
      input.idempotencyKey.length >= MIN_IDEMPOTENCY_KEY_LENGTH && input.idempotencyKey.length <= MAX_IDEMPOTENCY_KEY_LENGTH,
      'idempotencyKey',
      'Clé d’idempotence de 8 à 200 caractères attendue.',
    );
    check(input.payerPhone === undefined || PHONE_PATTERN.test(input.payerPhone), 'payerPhone', 'Téléphone au format E.164 attendu.');
    if (issues.length > 0) throw DomainError.validation(issues);
  }

  private async abandonPendingSiblings(input: InitiatePaymentInput): Promise<void> {
    const siblings = await this.db.run((tx) => this.repo.listPendingFor(tx, input.tenantId, input.purpose, input.referenceId));
    for (const sibling of siblings) await this.settlement.cancel(sibling);
  }

  /** Fournisseurs actifs et compétents, dans l'ordre du routage pays/devise. */
  private async candidates(input: InitiatePaymentInput): Promise<PaymentProvider[]> {
    const country = (await this.db.run((tx) => this.repo.tenantCountry(tx, input.tenantId))) ?? '';
    return resolveProviderOrder(this.env.PAYMENTS_ROUTES, country, input.currency)
      .map((code) => this.providers.getEnabled(code))
      .filter((provider): provider is PaymentProvider => provider !== undefined && provider.supports(input.channel, input.currency));
  }

  /** Crée la tentative ; si une requête concurrente a pris la même clé, renvoie celle-ci pour rejeu. */
  private async createAttempt(
    input: InitiatePaymentInput,
    amount: Prisma.Decimal,
    provider: string,
    providerReference: string,
  ): Promise<{ row: PaymentAttemptRow; replayOf?: undefined } | { row?: undefined; replayOf: PaymentAttemptRow }> {
    try {
      const row = await this.db.run((tx) =>
        this.repo.create(tx, {
          purpose: input.purpose,
          tenantId: input.tenantId,
          referenceId: input.referenceId,
          amount,
          currency: input.currency,
          channel: input.channel,
          provider,
          providerReference,
          idempotencyKey: input.idempotencyKey,
          payerPhoneHash: input.payerPhone ? Buffer.from(this.crypto.blindIndex(input.tenantId, input.payerPhone)).toString('hex') : null,
          description: input.description.trim(),
        }),
      );
      return { row };
    } catch (error: unknown) {
      if ((error as { code?: string }).code !== 'P2002') throw error;
      const winner = await this.db.run((tx) => this.repo.findByIdempotencyKey(tx, input.idempotencyKey));
      // Autre violation d'unicité : une tentative concurrente est déjà en attente pour cette facture SaaS.
      if (!winner) throw DomainError.conflict('payment_already_pending', 'Un paiement est déjà en cours pour cette facture.');
      return { replayOf: winner };
    }
  }

  /** Crée le paiement chez le premier fournisseur qui répond ; repli sur les suivants. */
  private async startCheckout(attempt: PaymentAttemptRow, input: InitiatePaymentInput, candidates: readonly PaymentProvider[]): Promise<InitiatedPayment> {
    let everyRefused = true;
    for (const provider of candidates) {
      try {
        const session = await provider.createCheckout({
          providerReference: attempt.providerReference!,
          amount: input.amount,
          currency: input.currency,
          channel: input.channel,
          description: input.description.trim(),
          payerPhone: input.payerPhone,
        });
        const updated = await this.db.run((tx) => this.repo.attachCheckout(tx, attempt.id, { provider: provider.code, ...session }));
        return this.toView(updated);
      } catch (error: unknown) {
        if (!(error instanceof ProviderError && error.kind === 'refused')) everyRefused = false;
        this.logger.warn({ attemptId: attempt.id, provider: provider.code, error: error instanceof Error ? error.name : 'unknown' }, 'Création du paiement impossible chez le fournisseur');
      }
    }
    // Refus explicite de tous les fournisseurs : aucune transaction n'existe, la tentative échoue. Échec technique : l'état
    // chez l'agrégateur est inconnu, la tentative reste « pending » et le job de relance l'interroge (docs/09 §R).
    if (everyRefused) {
      await this.settlement.failSilently(attempt, FAILURE_REASONS.refused);
      throw new PaymentProviderUnavailableError(attempt.id, false);
    }
    throw new PaymentProviderUnavailableError(attempt.id, true);
  }

  private replay(existing: PaymentAttemptRow, input: InitiatePaymentInput, amount: Prisma.Decimal): InitiatedPayment {
    const same =
      existing.tenantId === input.tenantId &&
      existing.purpose === input.purpose &&
      existing.referenceId === input.referenceId &&
      existing.currency === input.currency &&
      existing.channel === input.channel &&
      moneyEquals(existing.amount, amount);
    if (!same) {
      throw DomainError.conflict('idempotency_key_reused', 'Cette clé d’idempotence correspond à une autre demande de paiement.');
    }
    return this.toView(existing);
  }

  private toView(row: PaymentAttemptRow): InitiatedPayment {
    return {
      attemptId: row.id,
      status: row.status as PaymentAttemptStatus,
      provider: row.provider,
      checkoutUrl: row.checkoutUrl,
      instructions: row.instructions,
    };
  }
}
