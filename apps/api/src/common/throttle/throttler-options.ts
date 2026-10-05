import type { ThrottlerModuleOptions } from '@nestjs/throttler';
import type { Env } from '../../infrastructure/config/env';
import { ACCOUNT_THROTTLER } from './account-throttle';

/** Limiteur par IP : 300 requêtes par minute. */
export const DEFAULT_RATE_LIMIT = { ttl: 60_000, limit: 300 } as const;

/** Options du ThrottlerModule (le stockage Redis est branché par l'équipe AUTH, docs/11 D2). */
export function buildThrottlerOptions(_env: Env): ThrottlerModuleOptions {
  return { throttlers: [DEFAULT_RATE_LIMIT, ACCOUNT_THROTTLER] };
}
