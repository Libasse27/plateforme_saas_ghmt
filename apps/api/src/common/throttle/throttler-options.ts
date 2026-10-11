import type { ThrottlerModuleOptions, ThrottlerOptions } from '@nestjs/throttler';
import type { Env } from '../../infrastructure/config/env';
import { RateLimitThrottlerStorage } from '../rate-limit/rate-limit-throttler-storage';
import { rateLimitStoreFor } from '../rate-limit/rate-limit-runtime';
import { ACCOUNT_THROTTLER } from './account-throttle';
import { ipRateLimitKey } from './ip-bucket';

/** Limiteur par IP : 300 requêtes par minute, IPv6 regroupée par /64 (`ipRateLimitKey`). */
export const DEFAULT_RATE_LIMIT = {
  ttl: 60_000,
  limit: 300,
  getTracker: (req: Record<string, unknown>) => ipRateLimitKey(typeof req['ip'] === 'string' ? req['ip'] : undefined),
} as const satisfies ThrottlerOptions;

/** Options du ThrottlerModule : stockage Redis (repli mémoire) ou mémoire selon `RATE_LIMIT_STORE` (docs/11 D2). */
export function buildThrottlerOptions(env: Env): ThrottlerModuleOptions {
  return {
    throttlers: [DEFAULT_RATE_LIMIT, ACCOUNT_THROTTLER],
    storage: new RateLimitThrottlerStorage(rateLimitStoreFor(env)),
  };
}
