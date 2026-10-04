import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { DomainEventBus } from '../../src/common/events/domain-event-bus';
import type { DomainEventMap } from '../../src/common/events/domain-events';
import { PAYMENTS_GATEWAY, type InitiatePaymentInput, type PaymentsGateway } from '../../src/common/payments/payments-gateway';
import { ENV, type Env } from '../../src/infrastructure/config/env';
import { PlatformDb } from '../../src/infrastructure/prisma/platform-db.service';
import { PAYMENTS_FETCH } from '../../src/modules/payments/payments.constants';
import { ProviderRegistry } from '../../src/modules/payments/providers/provider-registry';
import { SandboxProvider } from '../../src/modules/payments/providers/sandbox.provider';

export const WEBHOOKS = '/api/v1/webhooks/payments';

export function http(app: INestApplication): ReturnType<typeof request> {
  return request(app.getHttpServer());
}

export interface PaymentsAppOptions {
  /** Variables d'environnement lues au démarrage (CINETPAY_*, PAYMENTS_ROUTES, PAYMENTS_SANDBOX_ENABLED…). */
  readonly env?: Readonly<Record<string, string>>;
  /** Remplace `fetch` pour les appels aux agrégateurs. */
  readonly fetch?: typeof fetch;
}

/** Application complète avec configuration de paiement ajustable et `fetch` des agrégateurs simulé. */
export async function createPaymentsApp(options: PaymentsAppOptions = {}): Promise<INestApplication> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(options.env ?? {})) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    let builder = Test.createTestingModule({ imports: [AppModule] });
    if (options.fetch) builder = builder.overrideProvider(PAYMENTS_FETCH).useValue(options.fetch);
    const moduleRef = await builder.compile();
    const app = moduleRef.createNestApplication({ logger: false, bodyParser: false });
    configureApp(app, app.get<Env>(ENV));
    await app.init();
    return app;
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export const gatewayOf = (app: INestApplication): PaymentsGateway => app.get<PaymentsGateway>(PAYMENTS_GATEWAY);

export function initiateInput(tenantId: string, overrides: Partial<InitiatePaymentInput> = {}): InitiatePaymentInput {
  return {
    purpose: 'patient_invoice',
    tenantId,
    referenceId: randomUUID(),
    amount: '15000.00',
    currency: 'XOF',
    channel: 'mobile_money',
    payerPhone: '+221771234567',
    description: 'Facture de test',
    idempotencyKey: `test-${randomUUID()}`,
    ...overrides,
  };
}

export const attemptRow = (app: INestApplication, id: string) =>
  app.get(PlatformDb).run((tx) => tx.paymentAttempt.findUniqueOrThrow({ where: { id } }));

export const eventRows = (app: INestApplication, attemptId: string) =>
  app.get(PlatformDb).run((tx) => tx.paymentEvent.findMany({ where: { attemptId }, orderBy: { receivedAt: 'asc' } }));

/** Modifie « le côté fournisseur » du simulateur (montant ou devise différents, statut forcé). */
export function patchSandboxTransaction(
  app: INestApplication,
  providerReference: string,
  data: { amount?: string; currency?: string; status?: 'pending' | 'succeeded' | 'failed' },
) {
  return app.get(PlatformDb).run((tx) => tx.sandboxTransaction.update({ where: { providerReference }, data }));
}

/** Webhook sandbox correctement signé (même mécanique que le simulateur). */
export function signedSandboxWebhook(
  app: INestApplication,
  providerReference: string,
  overrides: { eventId?: string; status?: 'succeeded' | 'failed' } = {},
): { body: string; signature: string } {
  const sandbox = app.get(ProviderRegistry).get('sandbox') as SandboxProvider;
  const body = JSON.stringify({ eventId: overrides.eventId ?? randomUUID(), providerReference, status: overrides.status ?? 'succeeded' });
  return { body, signature: sandbox.sign(Buffer.from(body)) };
}

export function postSandboxWebhook(app: INestApplication, webhook: { body: string; signature: string }) {
  return http(app).post(`${WEBHOOKS}/sandbox`).set('content-type', 'application/json').set('x-sandbox-signature', webhook.signature).send(webhook.body);
}

type Settled = DomainEventMap['payment.succeeded'];
export interface PublishedEvents {
  readonly succeeded: Settled[];
  readonly failed: DomainEventMap['payment.failed'][];
}

/** Enregistre les événements de paiement publiés sur le bus (en plus des abonnés réels de l'application). */
export function recordPaymentEvents(app: INestApplication): PublishedEvents {
  const published: PublishedEvents = { succeeded: [], failed: [] };
  const bus = app.get(DomainEventBus);
  bus.subscribe('payment.succeeded', (payload) => {
    published.succeeded.push(payload);
    return Promise.resolve();
  });
  bus.subscribe('payment.failed', (payload) => {
    published.failed.push(payload);
    return Promise.resolve();
  });
  return published;
}
