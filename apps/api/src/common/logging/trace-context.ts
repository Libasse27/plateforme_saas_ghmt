import { SpanStatusCode, type Attributes, type AttributeValue, type Span, type SpanStatus } from '@opentelemetry/api';
import type { ReadableSpan, SpanExporter, TimedEvent } from '@opentelemetry/sdk-trace-base';
import { sanitizeLogUrl } from './sanitize-url';

/**
 * Corrélation journaux ↔ traces et assainissement des attributs, statuts et événements d'erreur exportés (docs/13 D11, docs/01 §8.1).
 * Ce module ne charge aucun code applicatif : il est importé par `instrumentation.ts`, AVANT Nest.
 */

/** Noms des champs injectés dans chaque ligne Pino par l'instrumentation pino (champs obligatoires de docs/01 §8.1). */
export const TRACE_LOG_KEYS = { traceId: 'traceId', spanId: 'spanId', traceFlags: 'traceFlags' } as const;

/** Attribut de span portant l'établissement (jamais un label de métrique). */
export const TENANT_SPAN_ATTRIBUTE = 'ghmt.tenant.id';

type TenantIdResolver = () => string | undefined;
let tenantIdResolver: TenantIdResolver = () => undefined;

/** Branche la lecture du tenant courant (contexte de requête Nest) ; appelé par le module d'observabilité au démarrage. */
export function registerTenantIdResolver(resolver: TenantIdResolver): void {
  tenantIdResolver = resolver;
}

/** Tenant de la requête en cours, ou `undefined` hors requête authentifiée ; ne lève jamais. */
export function currentTenantId(): string | undefined {
  try {
    return tenantIdResolver();
  } catch {
    return undefined;
  }
}

/** `logHook` de l'instrumentation pino : ajoute `tenantId` à la ligne si une requête authentifiée est en cours. */
export function tenantLogHook(_span: Span | undefined, record: Record<string, unknown>): void {
  const tenantId = currentTenantId();
  if (tenantId) record['tenantId'] = tenantId;
}

/** Attributs jamais exportés : en-têtes capturés (authorization, cookie…), corps, query string. */
const DROPPED_ATTRIBUTE = /^(http\.(request|response)\.header\.|url\.query$)|(^|\.)body(\.|$)/;
/** Attributs porteurs d'une URL : sans query string ni jeton dans le chemin (même règle que les journaux). */
const URL_ATTRIBUTES = new Set(['http.target', 'http.url', 'url.path', 'url.full']);

function sanitizeUrlValue(value: AttributeValue): AttributeValue {
  return typeof value === 'string' ? (sanitizeLogUrl(value) ?? value) : value;
}

/** Commande Redis réduite à son nom : les arguments (clés de limitation : IP, identifiants) ne sont pas exportés. */
function redisCommandOnly(value: AttributeValue): AttributeValue {
  return typeof value === 'string' ? (value.split(' ')[0] ?? '') : value;
}

/** Copie assainie des attributs d'un span ; l'original n'est jamais modifié. */
export function redactSpanAttributes(attributes: Attributes): Attributes {
  const isRedis = attributes['db.system'] === 'redis' || attributes['db.system.name'] === 'redis';
  const redacted: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || DROPPED_ATTRIBUTE.test(key)) continue;
    if (URL_ATTRIBUTES.has(key)) redacted[key] = sanitizeUrlValue(value);
    else if (isRedis && (key === 'db.statement' || key === 'db.query.text')) redacted[key] = redisCommandOnly(value);
    else redacted[key] = value;
  }
  return redacted;
}

/** Libellé du statut en erreur exporté : le message d'origine (erreur pg, Prisma…) peut citer des valeurs saisies. */
export const GENERIC_ERROR_MESSAGE = 'error';
/** Seul attribut conservé d'un événement `exception` (le message et la pile peuvent contenir des données saisies). */
const EXCEPTION_EVENT = 'exception';
const EXCEPTION_TYPE_ATTRIBUTE = 'exception.type';

/** Statut assaini : un statut en erreur ne garde qu'un libellé générique. */
export function redactSpanStatus(status: SpanStatus): SpanStatus {
  return status.code === SpanStatusCode.ERROR ? { code: status.code, message: GENERIC_ERROR_MESSAGE } : status;
}

/** Événements assainis : un événement `exception` ne garde que `exception.type` ; les originaux ne sont pas modifiés. */
export function redactSpanEvents(events: readonly TimedEvent[]): TimedEvent[] {
  return events.map((event) => {
    if (event.name !== EXCEPTION_EVENT) return event;
    const type = event.attributes?.[EXCEPTION_TYPE_ATTRIBUTE];
    return { ...event, attributes: type === undefined ? {} : { [EXCEPTION_TYPE_ATTRIBUTE]: type } };
  });
}

/** Vue d'un span terminé dont attributs, statut et événements sont assainis (méthodes et contexte conservés par le prototype). */
function redactedView(span: ReadableSpan): ReadableSpan {
  return Object.create(span, {
    attributes: { value: redactSpanAttributes(span.attributes), enumerable: true },
    status: { value: redactSpanStatus(span.status), enumerable: true },
    events: { value: redactSpanEvents(span.events), enumerable: true },
  }) as ReadableSpan;
}

/**
 * Exportateur qui assainit chaque span avant de le confier à l'exportateur réel (OTLP) : défense en profondeur, en plus
 * du masquage du Collector (infra/observability/otel-collector.yaml).
 */
export class RedactingSpanExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}

  export(spans: ReadableSpan[], resultCallback: Parameters<SpanExporter['export']>[1]): void {
    this.inner.export(spans.map(redactedView), resultCallback);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}
