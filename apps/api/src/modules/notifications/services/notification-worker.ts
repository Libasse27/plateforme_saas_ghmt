import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Clock } from '../../../common/time/clock';
import { ENV, type Env } from '../../../infrastructure/config/env';
import { NotificationDispatcher } from './notification-dispatcher';

/** Boucle du dispatcher (D1) : une passe toutes les `NOTIFICATIONS_DISPATCH_INTERVAL_MS`, sans chevauchement. Inactive si le worker est désactivé. */
@Injectable()
export class NotificationWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly dispatcher: NotificationDispatcher,
    private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    if (!this.env.NOTIFICATIONS_WORKER_ENABLED) return;
    this.timer = setInterval(() => void this.tick(), this.env.NOTIFICATIONS_DISPATCH_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.dispatcher.runOnce(this.clock.now());
    } catch (error: unknown) {
      this.logger.error({ errorCode: error instanceof Error ? error.name : 'unknown' }, 'Échec d’une passe du dispatcher');
    } finally {
      this.running = false;
    }
  }
}
