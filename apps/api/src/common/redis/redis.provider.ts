import { Inject, Injectable, Logger, type OnModuleDestroy, type Provider } from '@nestjs/common';
import { Redis } from 'ioredis';
import { ENV, type Env } from '../../infrastructure/config/env';

/** Client ioredis partagé, ou `null` quand le stockage du limiteur est la mémoire (docs/11 §5.3). */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/** Délai maximal d'une commande : une panne Redis ne doit pas ralentir les requêtes de plus de 200 ms. */
export const REDIS_COMMAND_TIMEOUT_MS = 200;

const clients = new WeakMap<Env, Redis | null>();

/** Une seule connexion par configuration : le limiteur HTTP, le délai de connexion et `/health` la partagent. */
export function redisClientFor(env: Env): Redis | null {
  if (clients.has(env)) return clients.get(env) ?? null;
  const client = env.RATE_LIMIT_STORE === 'redis' && env.REDIS_URL ? createRedisClient(env.REDIS_URL) : null;
  clients.set(env, client);
  return client;
}

function createRedisClient(url: string): Redis {
  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
    enableOfflineQueue: false,
  });
  // Sans écouteur, ioredis journalise chaque tentative de reconnexion sur la sortie d'erreur (URL comprise) :
  // l'indisponibilité est signalée par `ResilientRateLimitStore` et `/health`.
  client.on('error', () => undefined);
  client.connect().catch(() => undefined);
  return client;
}

export const redisProvider: Provider = {
  provide: REDIS_CLIENT,
  inject: [ENV],
  useFactory: (env: Env): Redis | null => redisClientFor(env),
};

/** Ferme la connexion à l'arrêt de l'application. */
@Injectable()
export class RedisLifecycle implements OnModuleDestroy {
  private readonly logger = new Logger(RedisLifecycle.name);

  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis | null) {}

  async onModuleDestroy(): Promise<void> {
    if (!this.client || this.client.status === 'end') return;
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
      this.logger.warn('Connexion Redis fermée sans quitter proprement.');
    }
  }
}
