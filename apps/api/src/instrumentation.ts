/**
 * OpenTelemetry (docs/13 D11), démarré AVANT Nest : `node --require ./dist/instrumentation.js dist/main.js`
 * (commande du service `api` de infra/deploy/compose.prod.yml). Chargé avant http, express, pg, ioredis et pino, il
 * peut les instrumenter. Il n'importe aucun code applicatif Nest (seulement common/logging/trace-context et
 * common/metrics/route-label, sans dépendance).
 *
 * - Traces : HTTP (sans en-têtes ni query string), Express, Nest, PostgreSQL (requêtes paramétrées, jamais les valeurs),
 *   Redis (nom de commande seul), Prisma ; export OTLP/HTTP vers le Collector, qui applique l'échantillonnage en queue
 *   (10 %, 100 % des erreurs) et un second masquage (infra/observability/otel-collector.yaml).
 * - Journaux : `traceId`, `spanId` et `tenantId` injectés dans chaque ligne Pino ; lignes envoyées aussi au Collector
 *   (OTLP, vers Loki) après le masquage Pino.
 * Désactivé (aucun effet) si OTEL_ENABLED n'est pas `true` ou sans OTEL_EXPORTER_OTLP_ENDPOINT (refusé ensuite par env.ts).
 */
import { existsSync } from 'node:fs';
import { diag, DiagLogLevel, type DiagLogger } from '@opentelemetry/api';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { AlwaysOnSampler, BatchSpanProcessor, ParentBasedSampler, SimpleSpanProcessor, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { ATTR_HTTP_ROUTE, ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { PrismaInstrumentation } from '@prisma/instrumentation';
import { UNMATCHED_ROUTE, routeLabel, type RoutedRequest } from './common/metrics/route-label';
import { RedactingSpanExporter, TENANT_SPAN_ATTRIBUTE, TRACE_LOG_KEYS, currentTenantId, tenantLogHook } from './common/logging/trace-context';

/** Sondes de santé : appelées en boucle par l'orchestrateur, sans intérêt pour les traces. */
const UNTRACED_PATHS = new Set(['/api/v1/health', '/api/v1/health/ready']);
const LOCAL_ENV_FILE = '.env';

export interface TelemetryOptions {
  readonly serviceName: string;
  /** URL de base OTLP/HTTP du Collector (ex. http://otel-collector:4318) ; ignorée si `spanExporter` est fourni. */
  readonly endpoint?: string;
  /** Exportateur de spans (tests) ; enveloppé dans le masquage comme l'exportateur OTLP. */
  readonly spanExporter?: SpanExporter;
  /** Export par lots (défaut) ; `false` : export immédiat (tests). */
  readonly batch?: boolean;
}

export interface Telemetry {
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

/** Les diagnostics internes d'OpenTelemetry ne sortent qu'en avertissement, sans détail de requête. */
const diagLogger: DiagLogger = {
  error: (message) => process.stderr.write(`[otel] ${message}\n`),
  warn: (message) => process.stderr.write(`[otel] ${message}\n`),
  info: () => undefined,
  debug: () => undefined,
  verbose: () => undefined,
};

function instrumentations() {
  return [
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (req) => UNTRACED_PATHS.has((req.url ?? '').split('?')[0] ?? ''),
      // Appelé à la fin de la réponse, dans le contexte de la requête : le principal et la route Express sont connus.
      // `http.route` est posé ici (gabarit, jamais l'URL réelle), que l'instrumentation Express soit active ou non.
      applyCustomAttributesOnSpan: (span, request) => {
        const tenantId = currentTenantId();
        if (tenantId) span.setAttribute(TENANT_SPAN_ATTRIBUTE, tenantId);
        const route = routeLabel(request as RoutedRequest);
        if (route !== UNMATCHED_ROUTE && 'method' in request) {
          span.setAttribute(ATTR_HTTP_ROUTE, route);
          span.updateName(`${request.method} ${route}`);
        }
      },
    }),
    new ExpressInstrumentation(),
    new NestInstrumentation(),
    // Texte SQL paramétré seulement : les valeurs ($1…) ne sont jamais ajoutées.
    new PgInstrumentation({ enhancedDatabaseReporting: false }),
    new IORedisInstrumentation({ dbStatementSerializer: (command) => command }),
    new PrismaInstrumentation(),
    new PinoInstrumentation({ logKeys: TRACE_LOG_KEYS, logHook: tenantLogHook }),
  ];
}

/** Démarre le SDK (traces, et journaux vers le Collector si `endpoint`) ; à appeler avant de charger Nest. */
export function startTelemetry(options: TelemetryOptions): Telemetry {
  diag.setLogger(diagLogger, DiagLogLevel.WARN);
  // Métriques : Prometheus (prom-client, METRICS_PORT), pas d'export OTLP ; journaux : processeur configuré ci-dessous.
  process.env['OTEL_METRICS_EXPORTER'] ??= 'none';
  process.env['OTEL_LOGS_EXPORTER'] ??= 'none';
  const exporter = new RedactingSpanExporter(options.spanExporter ?? new OTLPTraceExporter({ url: `${options.endpoint}/v1/traces` }));
  const spanProcessor = options.batch === false ? new SimpleSpanProcessor(exporter) : new BatchSpanProcessor(exporter);
  const logRecordProcessors = options.endpoint && !options.spanExporter ? [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: `${options.endpoint}/v1/logs` }) })] : [];
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: options.serviceName, 'deployment.environment.name': process.env['NODE_ENV'] ?? 'development' }),
    // Toutes les traces partent vers le Collector, qui décide en queue (erreurs gardées) : D11.
    sampler: new ParentBasedSampler({ root: new AlwaysOnSampler() }),
    spanProcessors: [spanProcessor],
    logRecordProcessors,
    instrumentations: instrumentations(),
  });
  sdk.start();
  return {
    forceFlush: () => spanProcessor.forceFlush(),
    shutdown: () => sdk.shutdown(),
  };
}

/** Options lues dans l'environnement (OTEL_ENABLED, OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_SERVICE_NAME), ou `null`. */
export function telemetryOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): TelemetryOptions | null {
  if (env['OTEL_ENABLED'] !== 'true') return null;
  const endpoint = env['OTEL_EXPORTER_OTLP_ENDPOINT']?.trim().replace(/\/+$/, '');
  if (!endpoint) return null;
  return { serviceName: env['OTEL_SERVICE_NAME']?.trim() || 'ghmt-api', endpoint };
}

/**
 * En développement, apps/api/.env est lu ici aussi (main.ts le relit sans écraser) : OTEL_* y sont pris en compte.
 * Jamais en production (variables de l'orchestrateur) ni sous test (.env.test seul, télémétrie démarrée par le test).
 */
function loadLocalEnvFile(): void {
  const nodeEnv = process.env['NODE_ENV'];
  if (nodeEnv !== 'production' && nodeEnv !== 'test' && existsSync(LOCAL_ENV_FILE)) process.loadEnvFile(LOCAL_ENV_FILE);
}

/** Point d'entrée du préchargement (`--require`) : démarre si configuré, vide les tampons à l'arrêt. */
function bootFromEnv(): void {
  loadLocalEnvFile();
  const options = telemetryOptionsFromEnv();
  if (!options) return;
  const telemetry = startTelemetry(options);
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => void telemetry.shutdown());
}

// Préchargement : démarre seulement si OTEL_ENABLED=true (jamais sous test, où .env.test ne l'active pas).
bootFromEnv();
