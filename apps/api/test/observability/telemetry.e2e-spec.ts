import fs from 'node:fs';
import { SpanKind } from '@opentelemetry/api';
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// Seul module chargé statiquement avec l'API d'OpenTelemetry : la télémétrie démarre AVANT Nest, Express et Pino,
// comme en production (`node --require ./dist/instrumentation.js dist/main.js`).
import { startTelemetry, type Telemetry } from '../../src/instrumentation';

/**
 * docs/13 §11.3 point 4 : une requête produit une trace dont le `traceId` figure dans la ligne de journal, avec le
 * tenant ; aucun en-tête `authorization`, cookie, corps ni paramètre de requête dans les attributs exportés.
 */
const SECRET_QUERY = 'Dupont-RECHERCHE-SECRETE';
const COOKIE = 'ghmt_session=cookie-secret-de-test';
/** Valeur « saisie » citée par les messages d'erreur (erreur pg : `invalid input syntax for type uuid: "<valeur>"`). */
const SECRET_ERROR_VALUE = 'Dupont-ERREUR-SECRETE';

interface LogLine {
  readonly msg?: string;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly tenantId?: string;
  readonly req?: { readonly url?: string };
  readonly [key: string]: unknown;
}

/** Capture des lignes Pino (écrites par sonic-boom sur le descripteur 1) sans les afficher. */
function captureStdoutLogs(): { lines: LogLine[]; restore: () => void } {
  const lines: LogLine[] = [];
  const { writeSync, write } = fs;
  const keep = (fd: unknown, data: unknown): boolean => {
    if (fd !== 1 || (typeof data !== 'string' && !Buffer.isBuffer(data))) return false;
    for (const raw of data.toString().split('\n').filter(Boolean)) {
      try {
        lines.push(JSON.parse(raw) as LogLine);
      } catch {
        return false;
      }
    }
    return true;
  };
  fs.writeSync = ((fd: number, data: string | Buffer, ...rest: never[]) =>
    keep(fd, data) ? Buffer.byteLength(data) : writeSync(fd, data, ...rest)) as typeof fs.writeSync;
  fs.write = ((fd: number, data: string | Buffer, ...rest: unknown[]) => {
    if (!keep(fd, data)) return (write as (...args: unknown[]) => void)(fd, data, ...rest);
    const callback = rest.find((arg) => typeof arg === 'function') as ((e: null, n: number) => void) | undefined;
    callback?.(null, Buffer.byteLength(data));
  }) as typeof fs.write;
  return {
    lines,
    restore: () => {
      fs.writeSync = writeSync;
      fs.write = write;
    },
  };
}

describe('OpenTelemetry : traces, corrélation des journaux et masquage (D11)', () => {
  const exporter = new InMemorySpanExporter();
  let telemetry: Telemetry;
  let capture: ReturnType<typeof captureStdoutLogs>;
  let app: INestApplication;
  let tenantId: string;
  let adminToken: string;
  let request: typeof import('supertest').default;

  beforeAll(async () => {
    process.env['LOG_LEVEL'] = 'info';
    telemetry = startTelemetry({ serviceName: 'ghmt-api-test', spanExporter: exporter, batch: false });
    capture = captureStdoutLogs();
    // Chargés APRÈS le démarrage : http, express, pino et Nest sont instrumentés.
    request = (await import('supertest')).default;
    const { Test } = await import('@nestjs/testing');
    const { AppModule } = await import('../../src/app.module');
    const { ObservabilityModule } = await import('../../src/common/metrics/observability.module');
    const { configureApp } = await import('../../src/bootstrap');
    const { ENV } = await import('../../src/infrastructure/config/env');
    const { Controller, Get, Inject } = await import('@nestjs/common');
    const { AuthenticatedOnly } = await import('../../src/common/decorators/auth.decorators');
    const { PrismaService } = await import('../../src/infrastructure/prisma/prisma.service');
    // Contrôleur d'essai (défini après le démarrage de la télémétrie) : une erreur 500 applicative et une erreur
    // PostgreSQL dont le message cite une valeur saisie.
    @AuthenticatedOnly()
    @Controller('__otel-test')
    class ErrorProbeController {
      constructor(@Inject(PrismaService) private readonly prisma: InstanceType<typeof PrismaService>) {}

      @Get('boom')
      boom(): never {
        throw new Error(`échec sur la valeur "${SECRET_ERROR_VALUE}"`);
      }

      // La valeur est assemblée par le serveur : elle figure dans le message d'erreur de pg, pas dans le texte SQL.
      @Get('pg-error')
      async pgError(): Promise<unknown> {
        return this.prisma.$queryRawUnsafe(`SELECT ('${SECRET_ERROR_VALUE.slice(0, 7)}' || '${SECRET_ERROR_VALUE.slice(7)}')::uuid`);
      }
    }
    const { createTenantFixture } = await import('../helpers/fixtures');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule, ObservabilityModule], controllers: [ErrorProbeController] }).compile();
    app = moduleRef.createNestApplication({ logger: false, bodyParser: false });
    configureApp(app, app.get(ENV));
    await app.init();
    const tenant = await createTenantFixture(app, { prefix: 'otel' });
    tenantId = tenant.tenantId;
    adminToken = tenant.adminToken;
  });

  afterAll(async () => {
    capture?.restore();
    await app?.close();
    await telemetry?.shutdown();
    delete process.env['LOG_LEVEL'];
  });

  async function tracedRequest(): Promise<{ server: ReadableSpan; spans: ReadableSpan[]; line: LogLine | undefined }> {
    exporter.reset();
    capture.lines.length = 0;
    await request(app.getHttpServer())
      .get(`/api/v1/auth/me?search=${SECRET_QUERY}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Cookie', COOKIE)
      .expect(200);
    await telemetry.forceFlush();
    const spans = exporter.getFinishedSpans();
    const server = spans.find((span) => span.kind === SpanKind.SERVER);
    if (!server) throw new Error(`aucun span serveur parmi : ${spans.map((s) => s.name).join(', ')}`);
    const line = capture.lines.find((entry) => entry.msg === 'request completed' && entry.req?.url === '/api/v1/auth/me');
    return { server, spans, line };
  }

  it('la ligne de journal de la requête porte le traceId et le spanId de sa trace, et le tenant', async () => {
    const { server, line } = await tracedRequest();
    expect(line, JSON.stringify(capture.lines.map((l) => l.msg))).toBeDefined();
    expect(line!.traceId).toBe(server.spanContext().traceId);
    expect(line!.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(line!.tenantId).toBe(tenantId);
  });

  it('le span serveur porte le tenant (attribut de trace) et la route, sans query string', async () => {
    const { server } = await tracedRequest();
    expect(server.name).toBe('GET /api/v1/auth/me');
    expect(server.attributes['ghmt.tenant.id']).toBe(tenantId);
    expect(server.attributes['http.route']).toBe('/api/v1/auth/me');
    const target = server.attributes['http.target'] ?? server.attributes['url.path'];
    expect(target).toBe('/api/v1/auth/me');
  });

  it('les opérations de base de données de la requête appartiennent à la même trace', async () => {
    const { server, spans } = await tracedRequest();
    const children = spans.filter((span) => span.spanContext().traceId === server.spanContext().traceId && span !== server);
    expect(children.length).toBeGreaterThan(0);
  });

  it('aucun attribut exporté ne contient d’en-tête sensible, de cookie, de corps ni de paramètre de requête', async () => {
    const { spans } = await tracedRequest();
    const exported = JSON.stringify(spans.map((span) => ({ name: span.name, attributes: span.attributes, events: span.events })));
    for (const forbidden of [adminToken, 'Bearer', SECRET_QUERY, 'cookie-secret-de-test']) expect(exported).not.toContain(forbidden);
    const keys = spans.flatMap((span) => Object.keys(span.attributes));
    expect(keys.filter((key) => /header|body|url\.query/.test(key))).toEqual([]);
  });

  it('aucun secret dans les lignes de journal capturées', async () => {
    await tracedRequest();
    const logged = JSON.stringify(capture.lines);
    for (const forbidden of [adminToken, SECRET_QUERY, 'cookie-secret-de-test']) expect(logged).not.toContain(forbidden);
  });

  describe('erreurs : aucun message brut dans les spans exportés', () => {
    async function spansOfFailingRequest(path: string): Promise<ReadableSpan[]> {
      exporter.reset();
      const res = await request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(500);
      await telemetry.forceFlush();
      return exporter.getFinishedSpans();
    }

    /** Sérialisation de tout ce qui quitte le processus : nom, attributs, statut et événements de chaque span. */
    function exported(spans: ReadableSpan[]): string {
      return JSON.stringify(spans.map((span) => ({ name: span.name, attributes: span.attributes, status: span.status, events: span.events })));
    }

    it('une erreur 500 applicative : statut générique, événement exception réduit à son type', async () => {
      const spans = await spansOfFailingRequest('/api/v1/__otel-test/boom');
      expect(exported(spans)).not.toContain(SECRET_ERROR_VALUE);
      const exceptions = spans.flatMap((span) => span.events).filter((event) => event.name === 'exception');
      for (const event of exceptions) expect(Object.keys(event.attributes ?? {}).filter((key) => key !== 'exception.type')).toEqual([]);
      const errored = spans.filter((span) => span.status.code === 2);
      expect(errored.length).toBeGreaterThan(0);
      for (const span of errored) expect(span.status.message).toBe('error');
    });

    it('une erreur PostgreSQL (invalid input syntax … "<valeur>") : le span pg est en erreur sans message brut', async () => {
      const spans = await spansOfFailingRequest('/api/v1/__otel-test/pg-error');
      expect(exported(spans)).not.toContain(SECRET_ERROR_VALUE);
      const pgSpans = spans.filter((span) => span.attributes['db.system'] === 'postgresql' || span.attributes['db.system.name'] === 'postgresql');
      const pgErrors = pgSpans.filter((span) => span.status.code === 2);
      expect(pgErrors.length, `spans pg : ${pgSpans.map((s) => s.name).join(', ')}`).toBeGreaterThan(0);
      for (const span of pgErrors) {
        expect(span.status.message).toBe('error');
        for (const event of span.events.filter((e) => e.name === 'exception')) expect(Object.keys(event.attributes ?? {}).filter((key) => key !== 'exception.type')).toEqual([]);
      }
    });
  });
});
