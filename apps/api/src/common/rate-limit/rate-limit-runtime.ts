import { Logger } from '@nestjs/common';
import type { Env } from '../../infrastructure/config/env';
import { redisClientFor } from '../redis/redis.provider';
import { MemoryRateLimitStore } from './memory-rate-limit-store';
import type { RateLimitStore } from './rate-limit-store';
import { RedisRateLimitStore } from './redis-rate-limit-store';
import { ResilientRateLimitStore } from './resilient-rate-limit-store';

/** Jeton d'injection du stockage de limitation (limiteur HTTP et délai progressif). */
export const RATE_LIMIT_STORE = Symbol('RATE_LIMIT_STORE');

const stores = new WeakMap<Env, RateLimitStore>();
const logger = new Logger('RateLimit');

/**
 * Stockage de limitation de la configuration donnée, mémoïsé : `ThrottlerModule.forRootAsync` (qui ne reçoit que `Env`)
 * et le module cœur en obtiennent la même instance, donc le même compteur.
 */
export function rateLimitStoreFor(env: Env): RateLimitStore {
  const known = stores.get(env);
  if (known) return known;
  const client = redisClientFor(env);
  const store: RateLimitStore = client
    ? new ResilientRateLimitStore(new RedisRateLimitStore(client, env.RATE_LIMIT_KEY_PREFIX), new MemoryRateLimitStore(), {
        // Un avertissement à l'entrée et un à la sortie du mode dégradé ; jamais l'erreur brute (elle peut citer l'URL).
        onDegraded: (reason) => logger.warn(`Redis indisponible (${reason}) : limitation de débit en mémoire, non partagée entre instances.`),
        onRecovered: (degradedForMs) => logger.warn(`Redis de nouveau disponible après ${Math.round(degradedForMs / 1_000)} s : limitation de débit partagée rétablie.`),
      })
    : new MemoryRateLimitStore();
  stores.set(env, store);
  return store;
}
