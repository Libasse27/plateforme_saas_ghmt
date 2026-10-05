import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { ENV, type Env } from '../../src/infrastructure/config/env';

/** Remplace un provider par un double (`useValue`) dans l'application de test. */
export interface ProviderOverride {
  readonly token: string | symbol | (abstract new (...args: never[]) => unknown);
  readonly useValue: unknown;
}

export interface TestAppOptions {
  readonly providerOverrides?: readonly ProviderOverride[];
}

/**
 * Application complète (guards, filtre, enveloppe) connectée à la base de test.
 * `envOverrides` ne modifie que la configuration HTTP (ex. TRUSTED_PROXIES), pas les services.
 */
export async function createTestApp(envOverrides: Partial<Env> = {}, options: TestAppOptions = {}): Promise<INestApplication> {
  let builder = Test.createTestingModule({ imports: [AppModule] });
  // Doubles injectés à la place des providers réels (horloge simulée, passerelle de paiement…).
  for (const override of options.providerOverrides ?? []) builder = builder.overrideProvider(override.token).useValue(override.useValue);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ logger: false, bodyParser: false });
  configureApp(app, { ...app.get<Env>(ENV), ...envOverrides });
  await app.init();
  return app;
}
