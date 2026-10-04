import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { SaasInvoiceView } from '@ghmt/shared';
import { Clock } from '../../src/common/time/clock';
import { DomainEventBus } from '../../src/common/events/domain-event-bus';
import type { PaymentSettledPayload } from '../../src/common/events/domain-events';
import { Prisma, type Subscription } from '../../src/generated/prisma/client';
import { PlatformDb } from '../../src/infrastructure/prisma/platform-db.service';
import { FakePaymentsGateway } from '../helpers/fake-payments-gateway';
import type { TenantFixture } from '../helpers/fixtures';
import { MutableClock } from '../helpers/mutable-clock';
import { bearer, http } from '../helpers/platform';
import type { ProviderOverride } from '../helpers/test-app';
import { PAYMENTS_GATEWAY } from '../../src/common/payments/payments-gateway';

export const SUBSCRIPTION = '/api/v1/subscription';
export const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const PAYER_PHONE = '+221771234567';

export interface SubscriptionTestDoubles {
  readonly clock: MutableClock;
  readonly gateway: FakePaymentsGateway;
  readonly overrides: readonly ProviderOverride[];
}

/** Horloge pilotable et passerelle de paiement factice, à injecter dans `createTestApp`. */
export function createDoubles(): SubscriptionTestDoubles {
  const clock = new MutableClock();
  const gateway = new FakePaymentsGateway();
  return {
    clock,
    gateway,
    overrides: [
      { token: Clock, useValue: clock },
      { token: PAYMENTS_GATEWAY, useValue: gateway },
    ],
  };
}

export function readSubscription(app: INestApplication, tenantId: string): Promise<Subscription> {
  return app.get(PlatformDb).run((tx) => tx.subscription.findUniqueOrThrow({ where: { tenantId } }));
}

/** Modifie directement l'abonnement (scénarios de cycle de vie : dates d'échéance, statut de départ). */
export function patchSubscription(app: INestApplication, tenantId: string, data: Prisma.SubscriptionUncheckedUpdateInput): Promise<Subscription> {
  return app.get(PlatformDb).run((tx) => tx.subscription.update({ where: { tenantId }, data }));
}

export function tenantStatusOf(app: INestApplication, tenantId: string): Promise<string> {
  return app.get(PlatformDb).run(async (tx) => (await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } })).status);
}

/** Met l'abonnement `active` avec une période se terminant à `periodEnd` (renouvellement mensuel). */
export function makeActive(app: INestApplication, tenantId: string, periodEnd: Date, extra: Prisma.SubscriptionUncheckedUpdateInput = {}): Promise<Subscription> {
  return patchSubscription(app, tenantId, {
    status: 'active',
    trialEndsAt: null,
    currentPeriodStart: new Date(periodEnd.getTime() - 30 * MS_PER_DAY),
    currentPeriodEnd: periodEnd,
    statusChangedAt: new Date(periodEnd.getTime() - 30 * MS_PER_DAY),
    ...extra,
  });
}

export async function invoicesOf(app: INestApplication, tenant: TenantFixture, query: Record<string, string> = {}): Promise<SaasInvoiceView[]> {
  const res = await http(app).get(`${SUBSCRIPTION}/invoices`).query(query).set(bearer(tenant.adminToken)).expect(200);
  return res.body.data as SaasInvoiceView[];
}

/** Facture de conversion ouverte d'un tenant en essai (changement d'offre pendant l'essai). */
export async function openConversionInvoice(app: INestApplication, tenant: TenantFixture, planCode = 'standard'): Promise<SaasInvoiceView> {
  const res = await http(app)
    .post(`${SUBSCRIPTION}/change`)
    .set(bearer(tenant.adminToken))
    .send({ planCode, billingPeriod: 'monthly' })
    .expect(200);
  return res.body.data.invoice as SaasInvoiceView;
}

/** Publie `payment.succeeded` comme le ferait le module payments (indépendant de son implémentation). */
export function publishPaymentSucceeded(
  app: INestApplication,
  tenant: Pick<TenantFixture, 'tenantId'>,
  invoice: Pick<SaasInvoiceView, 'id' | 'total' | 'currency'>,
  overrides: Partial<PaymentSettledPayload> = {},
): Promise<void> {
  return app.get(DomainEventBus).publish('payment.succeeded', {
    attemptId: randomUUID(),
    purpose: 'saas_invoice',
    tenantId: tenant.tenantId,
    referenceId: invoice.id,
    amount: invoice.total,
    currency: invoice.currency,
    provider: 'sandbox',
    providerReference: `SBX-${randomUUID().slice(0, 8)}`,
    settledAt: new Date().toISOString(),
    ...overrides,
  });
}

export function recordStatusChanges(app: INestApplication): { from: string; to: string; tenantId: string }[] {
  const seen: { from: string; to: string; tenantId: string }[] = [];
  app.get(DomainEventBus).subscribe('subscription.status_changed', (payload) => {
    seen.push({ from: payload.from, to: payload.to, tenantId: payload.tenantId });
    return Promise.resolve();
  });
  return seen;
}
