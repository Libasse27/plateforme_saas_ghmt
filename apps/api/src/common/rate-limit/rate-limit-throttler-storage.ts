import type { ThrottlerStorage } from '@nestjs/throttler';
import type { RateLimitStore } from './rate-limit-store';

type StorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

const toSeconds = (ms: number): number => Math.ceil(ms / 1_000);

/** Adaptateur `ThrottlerStorage` de @nestjs/throttler (ttl et blocage en millisecondes) vers `RateLimitStore`. */
export class RateLimitThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly store: RateLimitStore) {}

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string): Promise<StorageRecord> {
    const hit = await this.store.hit(`${throttlerName}:${key}`, ttl, limit, blockDuration);
    return {
      totalHits: hit.totalHits,
      timeToExpire: toSeconds(hit.timeToExpireMs),
      isBlocked: hit.isBlocked,
      timeToBlockExpire: toSeconds(hit.timeToBlockExpireMs),
    };
  }
}
