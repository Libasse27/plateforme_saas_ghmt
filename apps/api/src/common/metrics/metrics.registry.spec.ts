import { describe, expect, it } from 'vitest';
import { HTTP_LABELS, createApiMetrics } from './metrics.registry';

describe('createApiMetrics', () => {
  it('histogramme de latence HTTP sans label tenant', async () => {
    const { registry, httpRequestDuration } = createApiMetrics();
    httpRequestDuration.observe({ method: 'GET', route: '/api/v1/health', status_code: '200' }, 0.012);
    const metric = await registry.getSingleMetricAsString('http_server_request_duration_seconds');
    expect(metric).toContain('route="/api/v1/health"');
    expect(HTTP_LABELS.some((label) => /tenant/i.test(label))).toBe(false);
  });

  it('chaque instance a son propre registre', () => {
    expect(createApiMetrics().registry).not.toBe(createApiMetrics().registry);
  });
});
