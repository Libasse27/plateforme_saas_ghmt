import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DomainEventBus } from '../../../common/events/domain-event-bus';
import type { PaymentSettledPayload } from '../../../common/events/domain-events';
import { Clock } from '../../../common/time/clock';
import { TenantDb } from '../../../infrastructure/prisma/tenant-db.service';
import { NotificationsRepository } from '../repositories/notifications.repository';

/**
 * Arrêt des relances au paiement (docs/10 D15) : sur `payment.succeeded` d'une facture SaaS, les relances en attente de cette
 * facture passent en `suppressed / invoice_settled`. Gestionnaire idempotent (rejeu par le job de relance des paiements).
 */
@Injectable()
export class SaasPaymentSubscriber implements OnModuleInit {
  constructor(
    private readonly bus: DomainEventBus,
    private readonly db: TenantDb,
    private readonly notifications: NotificationsRepository,
    private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe('payment.succeeded', (payload) => this.onSucceeded(payload));
  }

  async onSucceeded(payload: PaymentSettledPayload): Promise<void> {
    if (payload.purpose !== 'saas_invoice') return;
    await this.db.runAs(payload.tenantId, async (tx) => {
      await this.notifications.suppressInvoiceReminders(tx, payload.tenantId, payload.referenceId, this.clock.now());
    });
  }
}
