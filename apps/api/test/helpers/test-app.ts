import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { ENV, type Env } from '../../src/infrastructure/config/env';

/**
 * Application complète (guards, filtre, enveloppe) connectée à la base de test.
 * `envOverrides` ne modifie que la configuration HTTP (ex. TRUSTED_PROXIES), pas les services.
 */
export async function createTestApp(envOverrides: Partial<Env> = {}): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: false, bodyParser: false });
  configureApp(app, { ...app.get<Env>(ENV), ...envOverrides });
  await app.init();
  return app;
}
