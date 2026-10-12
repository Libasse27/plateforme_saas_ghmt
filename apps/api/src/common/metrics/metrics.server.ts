import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { ENV, type Env } from '../../infrastructure/config/env';
import { METRICS, type ApiMetrics } from './metrics.registry';

const METRICS_PATH = '/metrics';

/**
 * Serveur HTTP DISTINCT de l'API, sur METRICS_PORT (9464) : seul `GET /metrics` y répond. Il n'est ni publié ni routé
 * par Traefik (docs/13 D11) ; il écoute sur METRICS_HOST (en production, l'adresse de l'API sur le réseau `observability`) :
 * seul Prometheus le joint. Sous test, port éphémère (plusieurs
 * applications coexistent).
 */
@Injectable()
export class MetricsServer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MetricsServer.name);
  private server: Server | null = null;

  constructor(
    @Inject(METRICS) private readonly metrics: ApiMetrics,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const server = createServer((req, res) => {
      if (req.method !== 'GET' || (req.url ?? '').split('?')[0] !== METRICS_PATH) {
        res.writeHead(404).end();
        return;
      }
      this.metrics.registry
        .metrics()
        .then((body) => res.writeHead(200, { 'Content-Type': this.metrics.registry.contentType, 'Cache-Control': 'no-store' }).end(body))
        .catch(() => res.writeHead(500).end());
    });
    // Sous test, boucle locale : le port éphémère n'est pas exposé aux autres machines.
    const host = this.env.NODE_ENV === 'test' ? '127.0.0.1' : this.env.METRICS_HOST;
    const port = this.env.NODE_ENV === 'test' ? 0 : this.env.METRICS_PORT;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve());
    });
    this.server = server;
    this.logger.log(`Métriques Prometheus sur le port interne ${this.port()}`);
  }

  /** Port effectif (éphémère sous test). */
  port(): number {
    return (this.server?.address() as AddressInfo | null)?.port ?? this.env.METRICS_PORT;
  }

  async onApplicationShutdown(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
