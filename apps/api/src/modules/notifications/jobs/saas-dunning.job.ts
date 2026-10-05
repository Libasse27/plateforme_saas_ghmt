import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { NOTIFICATION_TYPES, type NotificationChannel } from '@ghmt/shared';
import { Clock } from '../../../common/time/clock';
import { ENV, type Env } from '../../../infrastructure/config/env';
import { PlatformDb } from '../../../infrastructure/prisma/platform-db.service';
import { TenantDb } from '../../../infrastructure/prisma/tenant-db.service';
import { deliveryDeadline } from '../domain/appointment-plan';
import { dedupKey } from '../domain/dedup-key';
import { dunningTypeFor, includesDirectors, latestReachedStep } from '../domain/dunning-schedule';
import { SAAS_DUNNING_STARTUP_DELAY_MS } from '../notifications.constants';
import { NotificationsRepository } from '../repositories/notifications.repository';
import { RecipientsRepository } from '../repositories/recipients.repository';

export interface DunningReport {
  readonly examined: number;
  readonly created: number;
  readonly errors: number;
}

interface OpenInvoice {
  readonly id: string;
  readonly number: string;
  readonly tenantId: string;
  readonly total: { toFixed(digits: number): string };
  readonly currency: string;
  readonly dueAt: Date;
}

const CHANNELS_OF = (typeCode: keyof typeof NOTIFICATION_TYPES): readonly NotificationChannel[] => NOTIFICATION_TYPES[typeCode].channels;
const OPEN_INVOICES_LIMIT = 5_000;

/**
 * Relances de factures SaaS (docs/10 D14, D15) : toutes les heures (minute 15) et 30 s après le démarrage. Pour chaque facture
 * `open`, SEULE la dernière étape atteinte du calendrier est créée (e-mail et in-app, aux propriétaires ; directeurs inclus à
 * partir de J+7). Idempotent par la clé de déduplication ; `payment.succeeded` supprime les relances en attente.
 */
@Injectable()
export class SaasDunningJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SaasDunningJob.name);
  private startup: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly platformDb: PlatformDb,
    private readonly db: TenantDb,
    private readonly recipients: RecipientsRepository,
    private readonly notifications: NotificationsRepository,
    private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    if (!this.env.NOTIFICATIONS_WORKER_ENABLED) return;
    this.startup = setTimeout(() => void this.scheduledRun(), SAAS_DUNNING_STARTUP_DELAY_MS);
    this.startup.unref();
  }

  onModuleDestroy(): void {
    if (this.startup) clearTimeout(this.startup);
    this.startup = null;
  }

  @Cron('15 * * * *')
  async scheduledRun(): Promise<void> {
    if (!this.env.NOTIFICATIONS_WORKER_ENABLED || this.running) return;
    this.running = true;
    try {
      const report = await this.runOnce(this.clock.now());
      this.logger.log({ ...report }, 'Relances de factures SaaS');
    } catch (error: unknown) {
      this.logger.error({ errorCode: error instanceof Error ? error.name : 'unknown' }, 'Échec des relances de factures SaaS');
    } finally {
      this.running = false;
    }
  }

  /** Une passe (testable avec une date donnée ; `tenantIds` restreint l'exécution, pour les tests). */
  async runOnce(now: Date, options: { readonly tenantIds?: readonly string[] } = {}): Promise<DunningReport> {
    const invoices = await this.platformDb.run((tx) =>
      tx.saasInvoice.findMany({
        where: { status: 'open', ...(options.tenantIds ? { tenantId: { in: [...options.tenantIds] } } : {}) },
        select: { id: true, number: true, tenantId: true, total: true, currency: true, dueAt: true },
        orderBy: { dueAt: 'asc' },
        take: OPEN_INVOICES_LIMIT,
      }),
    );
    let created = 0;
    let errors = 0;
    for (const invoice of invoices) {
      try {
        created += await this.remind(invoice, now);
      } catch (error: unknown) {
        errors += 1;
        this.logger.error({ invoiceId: invoice.id, errorCode: error instanceof Error ? error.name : 'unknown' }, 'Relance impossible pour une facture');
      }
    }
    return { examined: invoices.length, created, errors };
  }

  private async remind(invoice: OpenInvoice, now: Date): Promise<number> {
    const offsets = this.env.SAAS_DUNNING_OFFSETS_DAYS;
    const step = latestReachedStep(offsets, invoice.dueAt, now);
    if (!step) return 0;
    const typeCode = dunningTypeFor(step.index, offsets);
    const context = { invoiceNumber: invoice.number, amount: invoice.total.toFixed(2), currency: invoice.currency.trim(), dueAt: invoice.dueAt.toISOString(), offsetDays: step.offsetDays };
    return this.db.runAs(invoice.tenantId, async (tx) => {
      const recipients = await this.recipients.findOwners(tx, invoice.tenantId, now, includesDirectors(step.offsetDays));
      let written = 0;
      for (const recipient of recipients) {
        for (const channel of CHANNELS_OF(typeCode)) {
          written += await this.notifications.insert(
            tx,
            invoice.tenantId,
            {
              typeCode,
              category: 'administrative',
              channel,
              recipientType: 'user',
              recipientId: recipient.id,
              subjectType: 'saas_invoice',
              subjectId: invoice.id,
              subjectVersion: String(step.offsetDays),
              sourceEventId: null,
              dedupKey: dedupKey({ tenantId: invoice.tenantId, sourceKey: invoice.id, typeCode, recipientType: 'user', recipientId: recipient.id, channel, variant: String(step.offsetDays) }),
              locale: recipient.locale === 'en' ? 'en' : 'fr',
              context,
              suppressionReason: null,
              scheduledAt: now,
              deadlineAt: deliveryDeadline({ typeCode, category: 'administrative', channel, scheduledAt: now, startsAt: now }),
            },
            now,
          );
        }
      }
      return written;
    });
  }
}
