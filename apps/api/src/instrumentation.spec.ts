import { describe, expect, it } from 'vitest';
import { telemetryOptionsFromEnv } from './instrumentation';

describe('telemetryOptionsFromEnv (docs/13 §8 : OTEL_ENABLED, OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_SERVICE_NAME)', () => {
  it('désactivée par défaut ou sans endpoint', () => {
    expect(telemetryOptionsFromEnv({})).toBeNull();
    expect(telemetryOptionsFromEnv({ OTEL_ENABLED: 'false', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector:4318' })).toBeNull();
    expect(telemetryOptionsFromEnv({ OTEL_ENABLED: 'true', OTEL_EXPORTER_OTLP_ENDPOINT: '  ' })).toBeNull();
  });

  it('active : endpoint sans barre finale, nom de service par défaut ghmt-api', () => {
    expect(telemetryOptionsFromEnv({ OTEL_ENABLED: 'true', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector:4318/' })).toEqual({
      serviceName: 'ghmt-api',
      endpoint: 'http://otel-collector:4318',
    });
    expect(telemetryOptionsFromEnv({ OTEL_ENABLED: 'true', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318', OTEL_SERVICE_NAME: 'ghmt-worker' })?.serviceName).toBe('ghmt-worker');
  });
});
