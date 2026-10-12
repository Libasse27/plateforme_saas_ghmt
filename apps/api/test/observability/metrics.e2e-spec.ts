import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { MetricsServer } from '../../src/common/metrics/metrics.server';
import { ObservabilityModule } from '../../src/common/metrics/observability.module';
import { ENV } from '../../src/infrastructure/config/env';
import { createTenantFixture, type TenantFixture } from '../helpers/fixtures';

/**
 * docs/13 §11.3 point 5 : `/metrics` sur le port interne METRICS_PORT (port éphémère sous test), histogramme de latence
 * par route (gabarit, jamais l'URL réelle), sans label `tenantId` ; jamais servi par l'API ni routé par Traefik.
 */
const DEPLOY_DIR = resolve(__dirname, '../../../../infra/deploy');
const UNKNOWN_ID = '0190a1b2-0000-7000-8000-00000000dead';

describe('métriques Prometheus (D11)', () => {
  let app: INestApplication;
  let tenant: TenantFixture;
  let metricsUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule, ObservabilityModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false, bodyParser: false });
    configureApp(app, app.get(ENV));
    await app.init();
    tenant = await createTenantFixture(app, { prefix: 'metr' });
    const port = app.get(MetricsServer).port();
    metricsUrl = `http://127.0.0.1:${port}/metrics`;
  });

  afterAll(async () => {
    await app?.close();
  });

  async function scrape(): Promise<string> {
    const response = await fetch(metricsUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    return response.text();
  }

  it('sert /metrics sur un serveur distinct de l’API, qui ne l’expose pas', async () => {
    expect(app.get(MetricsServer).port()).not.toBe(app.get(ENV).PORT);
    await request(app.getHttpServer()).get('/metrics').expect(404);
    await request(app.getHttpServer()).get('/api/v1/metrics').expect(404);
    const other = await fetch(metricsUrl.replace('/metrics', '/autre'));
    expect(other.status).toBe(404);
  });

  it('mesure la latence par gabarit de route, méthode et statut', async () => {
    await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    await request(app.getHttpServer()).get(`/api/v1/iam/users/${UNKNOWN_ID}`).set('Authorization', `Bearer ${tenant.adminToken}`);
    await request(app.getHttpServer()).get('/api/v1/route-inconnue-xyz').expect(404);
    const body = await scrape();
    expect(body).toContain('# TYPE http_server_request_duration_seconds histogram');
    expect(body).toMatch(/http_server_request_duration_seconds_count\{method="GET",route="\/api\/v1\/health",status_code="200"\} [1-9]/);
    expect(body).toMatch(/http_server_request_duration_seconds_bucket\{le="0\.5",method="GET",route="\/api\/v1\/iam\/users\/:id",status_code="\d{3}"\}/);
    // Jamais l'identifiant réel ni un chemin inconnu en label (cardinalité bornée).
    expect(body).not.toContain(UNKNOWN_ID);
    expect(body).not.toContain('route-inconnue-xyz');
    expect(body).toMatch(/route="unmatched",status_code="404"/);
  });

  it('n’a aucun label tenant ni identifiant d’établissement', async () => {
    const body = await scrape();
    expect(body).not.toMatch(/\{[^}]*tenant[^}]*\}/i);
    expect(body).not.toContain(tenant.tenantId);
  });

  it('expose l’état du limiteur et la file de notifications due', async () => {
    const body = await scrape();
    expect(body).toMatch(/^ghmt_rate_limit_degraded 0$/m);
    expect(body).toMatch(/^ghmt_notifications_due_tenants \d+$/m);
    expect(body).toContain('process_cpu_seconds_total');
  });

  it('METRICS_PORT n’est ni publié ni routé par Traefik (topologie de référence)', () => {
    const dynamic = readFileSync(resolve(DEPLOY_DIR, 'traefik/dynamic.yml'), 'utf8');
    expect(dynamic).not.toMatch(/9464|metrics/i);
    const compose = readFileSync(resolve(DEPLOY_DIR, 'compose.prod.yml'), 'utf8');
    const api = compose.slice(compose.indexOf('\n  api:'), compose.indexOf('\n  redis:'));
    expect(api).toContain('METRICS_PORT');
    expect(api).not.toMatch(/\n\s+ports:/);
  });

  it('les métriques écoutent sur l’adresse de l’API du réseau observability ; le Collector n’est que sur observability', () => {
    const compose = readFileSync(resolve(DEPLOY_DIR, 'compose.prod.yml'), 'utf8');
    const api = compose.slice(compose.indexOf('\n  api:'), compose.indexOf('\n  redis:'));
    expect(api).toContain('METRICS_HOST: 172.29.0.10');
    expect(api).toContain('ipv4_address: 172.29.0.10');
    const collector = compose.slice(compose.indexOf('\n  otel-collector:'), compose.indexOf('# --- Tâches de sauvegarde'));
    expect(collector).toMatch(/networks: \[observability\]/);
  });
});
