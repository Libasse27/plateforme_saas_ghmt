import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import type { Env } from './infrastructure/config/env';

export const API_PREFIX = 'api/v1';
const BODY_LIMIT = '1mb';

/** Configuration HTTP partagée par main.ts et les tests e2e. */
export function configureApp(app: INestApplication, env: Env): void {
  const expressApp = app as NestExpressApplication;
  // X-Forwarded-For n'est cru que s'il vient d'un proxy listé (CIDR ou mot-clé Express, défaut « loopback »).
  expressApp.set('trust proxy', env.TRUSTED_PROXIES.length > 0 ? [...env.TRUSTED_PROXIES] : false);
  expressApp.useBodyParser('json', { limit: BODY_LIMIT });
  app.use(helmet());
  app.enableCors({ origin: env.CORS_ORIGINS, credentials: true });
  app.setGlobalPrefix(API_PREFIX);
  app.enableShutdownHooks();
}
