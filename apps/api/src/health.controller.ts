import { Controller, Get, Inject } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { Public } from './common/decorators/auth.decorators';
import { RATE_LIMIT_STORE } from './common/rate-limit/rate-limit-runtime';
import type { RateLimitStore } from './common/rate-limit/rate-limit-store';
import { ResilientRateLimitStore } from './common/rate-limit/resilient-rate-limit-store';
import { REDIS_CLIENT } from './common/redis/redis.provider';

export type DependencyState = 'up' | 'down' | 'disabled';
/** Stockage effectif de la limitation : Redis partagé, repli mémoire par instance (panne Redis), ou mémoire configurée. */
export type RateLimitState = 'redis' | 'memory_fallback' | 'memory';

/** Sonde publique : aucun détail d'infrastructure (docs/11 §14.2 M6). */
export interface HealthStatus {
  readonly status: 'ok';
}

export interface HealthReport extends HealthStatus {
  readonly checks: { readonly redis: DependencyState; readonly rateLimit: RateLimitState };
}

@Controller('health')
export class HealthController {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
    @Inject(RATE_LIMIT_STORE) private readonly rateLimitStore: RateLimitStore,
  ) {}

  /** Sonde de vivacité publique (routée par le proxy) : `{ status }` seulement. */
  @Public()
  @Get()
  check(): Promise<HealthStatus> {
    return Promise.resolve({ status: 'ok' });
  }

  /**
   * Sonde détaillée, NON routée par le proxy (réseau interne, orchestrateur) : reste `ok` même si Redis est tombé
   * (le limiteur est alors en repli mémoire), l'état figure dans `checks` (`rateLimit: 'memory_fallback'`).
   */
  @Public()
  @Get('ready')
  async ready(): Promise<HealthReport> {
    return { status: 'ok', checks: { redis: await this.redisState(), rateLimit: this.rateLimitState() } };
  }

  private rateLimitState(): RateLimitState {
    if (!(this.rateLimitStore instanceof ResilientRateLimitStore)) return 'memory';
    return this.rateLimitStore.isDegraded() ? 'memory_fallback' : 'redis';
  }

  private async redisState(): Promise<DependencyState> {
    if (!this.redis) return 'disabled';
    try {
      return (await this.redis.ping()) === 'PONG' ? 'up' : 'down';
    } catch {
      return 'down';
    }
  }
}
