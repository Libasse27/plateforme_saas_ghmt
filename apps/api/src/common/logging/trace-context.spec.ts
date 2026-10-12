import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it } from 'vitest';
import { SpanStatusCode } from '@opentelemetry/api';
import { RedactingSpanExporter, currentTenantId, redactSpanAttributes, redactSpanEvents, redactSpanStatus, registerTenantIdResolver, TRACE_LOG_KEYS, tenantLogHook } from './trace-context';

describe('redactSpanAttributes (docs/13 D11 : aucun en-tête sensible, corps ni paramètre de requête exporté)', () => {
  it('retire les en-têtes capturés, les corps et la query string', () => {
    const redacted = redactSpanAttributes({
      'http.request.header.authorization': ['Bearer eyJ.secret'],
      'http.request.header.cookie': ['ghmt_session=abc'],
      'http.response.header.set-cookie': ['ghmt_session=abc'],
      'http.request.body': '{"password":"x"}',
      'http.request.body.size': 42,
      'url.query': 'search=Dupont',
      'http.method': 'GET',
      'http.status_code': 200,
    });
    expect(redacted).toEqual({ 'http.method': 'GET', 'http.status_code': 200 });
  });

  it('assainit les URL : sans query string ni jeton d’invitation dans le chemin', () => {
    const redacted = redactSpanAttributes({
      'http.target': '/api/v1/patients?search=Dupont',
      'url.path': '/api/v1/auth/invitations/tok-123',
      'http.url': 'http://api:3000/api/v1/patients?search=Dupont',
      'url.full': 'http://api:3000/api/v1/auth/invitations/tok-123?x=1',
      'http.route': '/api/v1/patients/:patientId',
    });
    expect(redacted).toEqual({
      'http.target': '/api/v1/patients',
      'url.path': '/api/v1/auth/invitations/:token',
      'http.url': 'http://api:3000/api/v1/patients',
      'url.full': 'http://api:3000/api/v1/auth/invitations/:token',
      'http.route': '/api/v1/patients/:patientId',
    });
  });

  it('ne garde des commandes Redis que le nom de la commande (les clés portent IP et identifiants)', () => {
    expect(redactSpanAttributes({ 'db.system': 'redis', 'db.statement': 'incr rl:ip:203.0.113.5' })).toEqual({ 'db.system': 'redis', 'db.statement': 'incr' });
  });
});

describe('messages d’erreur des spans (statut et événements exception) : jamais exportés', () => {
  it('ne garde d’un événement exception que exception.type', () => {
    const [event] = redactSpanEvents([
      {
        name: 'exception',
        time: [1, 0],
        attributes: {
          'exception.type': 'PrismaClientValidationError',
          'exception.message': 'invalid input syntax for type uuid: "Dupont"',
          'exception.stacktrace': 'Error: valeur "Dupont"\n    at x',
          'exception.escaped': true,
        },
      },
    ]);
    expect(event!.attributes).toEqual({ 'exception.type': 'PrismaClientValidationError' });
    expect(event!.name).toBe('exception');
  });

  it('laisse intacts les autres événements et ne modifie pas l’original', () => {
    const original = [{ name: 'exception', time: [1, 0] as [number, number], attributes: { 'exception.message': 'x' } }, { name: 'autre', time: [2, 0] as [number, number], attributes: { a: 1 } }];
    const redacted = redactSpanEvents(original);
    expect(redacted[1]).toEqual(original[1]);
    expect(original[0]!.attributes).toEqual({ 'exception.message': 'x' });
  });

  it('remplace le message d’un statut en erreur par un libellé générique, sans toucher aux autres statuts', () => {
    expect(redactSpanStatus({ code: SpanStatusCode.ERROR, message: 'invalid input syntax: "Dupont"' })).toEqual({ code: SpanStatusCode.ERROR, message: 'error' });
    expect(redactSpanStatus({ code: SpanStatusCode.UNSET })).toEqual({ code: SpanStatusCode.UNSET });
    expect(redactSpanStatus({ code: SpanStatusCode.OK })).toEqual({ code: SpanStatusCode.OK });
  });
});

describe('RedactingSpanExporter', () => {
  it('exporte un span en erreur sans message ni trace de pile (statut, exception.message, exception.stacktrace)', () => {
    const inner = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(new RedactingSpanExporter(inner))] });
    const span = provider.getTracer('test').startSpan('SELECT');
    span.recordException(new Error('invalid input syntax for type uuid: "Dupont-SECRET"'));
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'invalid input syntax for type uuid: "Dupont-SECRET"' });
    span.end();
    const [exported] = inner.getFinishedSpans();
    expect(JSON.stringify({ status: exported!.status, events: exported!.events })).not.toContain('Dupont-SECRET');
    expect(exported!.status).toEqual({ code: SpanStatusCode.ERROR, message: 'error' });
    expect(exported!.events[0]!.attributes).toEqual({ 'exception.type': 'Error' });
  });

  function exportThrough(attributes: Record<string, string>): { spans: ReadableSpan[] } {
    const inner = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(new RedactingSpanExporter(inner))] });
    provider.getTracer('test').startSpan('GET', { attributes }).end();
    return { spans: inner.getFinishedSpans() };
  }

  it('exporte des spans assainis qui conservent leur contexte (traceId, spanId)', () => {
    const { spans } = exportThrough({ 'http.request.header.authorization': 'Bearer x', 'http.target': '/a?b=c' });
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes).toEqual({ 'http.target': '/a' });
    expect(spans[0]!.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(spans[0]!.name).toBe('GET');
  });

  it('relaie forceFlush et shutdown à l’exportateur sous-jacent', async () => {
    const calls: string[] = [];
    const inner: SpanExporter = {
      // 0 : ExportResultCode.SUCCESS (@opentelemetry/core).
      export: (_spans, done) => done({ code: 0 }),
      shutdown: async () => void calls.push('shutdown'),
      forceFlush: async () => void calls.push('flush'),
    };
    const exporter = new RedactingSpanExporter(inner);
    await exporter.forceFlush();
    await exporter.shutdown();
    expect(calls).toEqual(['flush', 'shutdown']);
  });
});

describe('tenantId dans les journaux (docs/01 §8.1)', () => {
  afterEach(() => registerTenantIdResolver(() => undefined));

  it('nomme traceId et spanId comme les champs obligatoires des journaux', () => {
    expect(TRACE_LOG_KEYS).toEqual({ traceId: 'traceId', spanId: 'spanId', traceFlags: 'traceFlags' });
  });

  it('ajoute le tenant courant à la ligne de journal, et rien hors contexte authentifié', () => {
    const record: Record<string, unknown> = {};
    tenantLogHook(undefined, record);
    expect(record).toEqual({});
    registerTenantIdResolver(() => '0190a1b2-0000-7000-8000-000000000001');
    expect(currentTenantId()).toBe('0190a1b2-0000-7000-8000-000000000001');
    tenantLogHook(undefined, record);
    expect(record).toEqual({ tenantId: '0190a1b2-0000-7000-8000-000000000001' });
  });

  it('un résolveur qui lève ne casse jamais la journalisation', () => {
    registerTenantIdResolver(() => {
      throw new Error('hors contexte');
    });
    expect(currentTenantId()).toBeUndefined();
  });
});
