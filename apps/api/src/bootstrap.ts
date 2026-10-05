import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { IncomingMessage } from 'node:http';
import helmet from 'helmet';
import type { Env } from './infrastructure/config/env';

export const API_PREFIX = 'api/v1';
const BODY_LIMIT = '1mb';

/** Chemin des webhooks de paiement : la signature porte sur les octets exacts reçus, qu'il faut donc conserver. */
const WEBHOOK_PATH_PREFIX = `/${API_PREFIX}/webhooks/`;

function keepWebhookRawBody(req: IncomingMessage & { rawBody?: Buffer }, _res: unknown, body: Buffer): void {
  if (req.url?.startsWith(WEBHOOK_PATH_PREFIX)) req.rawBody = body;
}

/** Configuration HTTP partagée par main.ts et les tests e2e. */
export function configureApp(app: INestApplication, env: Env): void {
  const expressApp = app as NestExpressApplication;
  // X-Forwarded-For n'est cru que s'il vient d'un proxy listé (CIDR ou mot-clé Express, défaut « loopback »).
  expressApp.set('trust proxy', env.TRUSTED_PROXIES.length > 0 ? [...env.TRUSTED_PROXIES] : false);
  // `verify` n'est pas dans le type Nest (réservé à l'option globale `rawBody`) mais est transmis tel quel à body-parser :
  // on ne conserve les octets bruts que pour les webhooks, pas pour toutes les requêtes.
  expressApp.useBodyParser('json', { limit: BODY_LIMIT, verify: keepWebhookRawBody } as Parameters<typeof expressApp.useBodyParser<'json'>>[1]);
  app.use(helmet());
  app.enableCors({ origin: env.CORS_ORIGINS, credentials: true });
  app.setGlobalPrefix(API_PREFIX);
  app.enableShutdownHooks();
}
