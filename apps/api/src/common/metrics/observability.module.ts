import { Inject, type MiddlewareConsumer, Module, type NestModule, type OnModuleInit } from '@nestjs/common';
import { RequestContext } from '../context/request-context';
import { registerTenantIdResolver } from '../logging/trace-context';
import { RATE_LIMIT_STORE } from '../rate-limit/rate-limit-runtime';
import type { RateLimitStore } from '../rate-limit/rate-limit-store';
import { TenantDb } from '../../infrastructure/prisma/tenant-db.service';
import { registerNotificationsDueGauge, registerRateLimitGauge } from './app-gauges';
import { HttpMetricsMiddleware } from './http-metrics.middleware';
import { METRICS, createApiMetrics, type ApiMetrics } from './metrics.registry';
import { MetricsServer } from './metrics.server';

/**
 * Observabilité de l'API (docs/13 D11) : métriques Prometheus sur METRICS_PORT, latence par route, jauges d'exploitation
 * (alertes D12), et tenant courant pour les traces et les journaux (instrumentation.ts, sans dépendance vers Nest).
 */
@Module({
  providers: [{ provide: METRICS, useFactory: createApiMetrics }, MetricsServer, HttpMetricsMiddleware],
  exports: [METRICS],
})
export class ObservabilityModule implements NestModule, OnModuleInit {
  constructor(
    @Inject(METRICS) private readonly metrics: ApiMetrics,
    @Inject(RATE_LIMIT_STORE) private readonly rateLimitStore: RateLimitStore,
    private readonly db: TenantDb,
    private readonly context: RequestContext,
  ) {}

  onModuleInit(): void {
    registerRateLimitGauge(this.metrics, this.rateLimitStore);
    registerNotificationsDueGauge(this.metrics, this.db);
    registerTenantIdResolver(() => this.context.principal?.tenantId);
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(HttpMetricsMiddleware).forRoutes('*');
  }
}
