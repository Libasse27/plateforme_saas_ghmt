import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { ENV, type Env } from './infrastructure/config/env';

const LOCAL_ENV_FILE = '.env';

/** Hors production, charge apps/api/.env ; en production, les variables viennent de l'orchestrateur. */
function loadLocalEnvFile(): void {
  if (process.env['NODE_ENV'] !== 'production' && existsSync(LOCAL_ENV_FILE)) process.loadEnvFile(LOCAL_ENV_FILE);
}

async function bootstrap(): Promise<void> {
  loadLocalEnvFile();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, bodyParser: false });
  app.useLogger(app.get(Logger));
  const env = app.get<Env>(ENV);
  configureApp(app, env);
  await app.listen(env.PORT);
}

void bootstrap();
