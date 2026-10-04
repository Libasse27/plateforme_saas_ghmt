import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Clock } from '../../../common/time/clock';
import { PlatformDb } from '../../../infrastructure/prisma/platform-db.service';
import { PENDING_EXPIRY_MS, PENDING_RETRY_AFTER_MS, RECHECK_MIN_INTERVAL_MS, REPUBLISH_AFTER_MS, RETRY_BATCH_SIZE } from '../payments.constants';
import { PaymentsRepository, type PaymentAttemptRow } from '../repositories/payments.repository';
import { PaymentSettlementService } from './payment-settlement.service';

export interface RetryReport {
  readonly checked: number;
  readonly expired: number;
  readonly republished: number;
  readonly errors: number;
}

const EVERY_TEN_MINUTES = '*/10 * * * *';

/**
 * Filet de sécurité des webhooks perdus : toutes les 10 minutes, les tentatives `pending` depuis plus de 10 minutes
 * sont interrogées auprès de l'agrégateur (pendant 24 h, puis expirées) et les règlements non notifiés sont republiés.
 */
@Injectable()
export class PaymentRetryJob {
  private readonly logger = new Logger(PaymentRetryJob.name);
  private running = false;

  constructor(
    private readonly db: PlatformDb,
    private readonly repo: PaymentsRepository,
    private readonly settlement: PaymentSettlementService,
    private readonly clock: Clock,
  ) {}

  @Cron(EVERY_TEN_MINUTES)
  async scheduledRun(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runOnce(this.clock.now());
    } catch (error: unknown) {
      this.logger.error({ error: error instanceof Error ? error.name : 'unknown' }, 'Échec de la relance des paiements');
    } finally {
      this.running = false;
    }
  }

  /** Une passe de relance (testable avec une date donnée). */
  async runOnce(now: Date): Promise<RetryReport> {
    const olderThan = new Date(now.getTime() - PENDING_RETRY_AFTER_MS);
    const notCheckedSince = new Date(now.getTime() - RECHECK_MIN_INTERVAL_MS);
    const expiryLimit = new Date(now.getTime() - PENDING_EXPIRY_MS);
    const due = await this.db.run((tx) => this.repo.listPendingDue(tx, olderThan, notCheckedSince, RETRY_BATCH_SIZE));

    let checked = 0;
    let expired = 0;
    let errors = 0;
    for (const attempt of due) {
      try {
        if (attempt.createdAt <= expiryLimit) {
          await this.settlement.expire(attempt);
          expired += 1;
        } else {
          await this.settlement.verifyAndSettle(attempt);
          checked += 1;
        }
      } catch (error: unknown) {
        errors += 1;
        this.logger.warn({ attemptId: attempt.id, error: error instanceof Error ? error.name : 'unknown' }, 'Relance impossible pour une tentative');
      }
    }
    const republished = await this.republishUnnotified(now);
    return { checked, expired, republished, errors };
  }

  private async republishUnnotified(now: Date): Promise<number> {
    const settledBefore = new Date(now.getTime() - REPUBLISH_AFTER_MS);
    const rows: PaymentAttemptRow[] = await this.db.run((tx) => this.repo.listUnnotified(tx, settledBefore, RETRY_BATCH_SIZE));
    for (const row of rows) await this.settlement.ensureNotified(row);
    return rows.length;
  }
}
