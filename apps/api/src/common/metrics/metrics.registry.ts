import { Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/** Jeton d'injection du registre Prometheus de l'API. */
export const METRICS = Symbol('METRICS');

/**
 * Seuils (secondes) choisis autour des SLO de docs/01 §8.2 : p95 GET < 300 ms (alerte 500 ms), p95 POST < 500 ms
 * (alerte 800 ms).
 */
export const HTTP_DURATION_BUCKETS = [0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 0.8, 1, 2, 5] as const;

/** Labels autorisés : JAMAIS `tenantId` ni identifiant (docs/13 D11, cardinalité bornée). */
export const HTTP_LABELS = ['method', 'route', 'status_code'] as const;
type HttpLabel = (typeof HTTP_LABELS)[number];

export interface ApiMetrics {
  readonly registry: Registry;
  readonly httpRequestDuration: Histogram<HttpLabel>;
}

/** Registre propre à une instance d'application (aucun registre global : plusieurs applications de test coexistent). */
export function createApiMetrics(): ApiMetrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const httpRequestDuration = new Histogram<HttpLabel>({
    name: 'http_server_request_duration_seconds',
    help: 'Durée des requêtes HTTP traitées par l’API, par gabarit de route.',
    labelNames: HTTP_LABELS,
    buckets: [...HTTP_DURATION_BUCKETS],
    registers: [registry],
  });
  return { registry, httpRequestDuration };
}
