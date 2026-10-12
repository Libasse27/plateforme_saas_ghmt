import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { METRICS, type ApiMetrics } from './metrics.registry';
import { routeLabel } from './route-label';

const NS_PER_SECOND = 1e9;

/**
 * Mesure chaque requête à la fin de sa réponse (`finish`), y compris les refus des guards et les 404 : la route est
 * alors connue d'Express si un contrôleur l'a prise en charge.
 */
@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  constructor(@Inject(METRICS) private readonly metrics: ApiMetrics) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const start = process.hrtime.bigint();
    res.once('finish', () => {
      const seconds = Number(process.hrtime.bigint() - start) / NS_PER_SECOND;
      this.metrics.httpRequestDuration.observe({ method: req.method, route: routeLabel(req), status_code: String(res.statusCode) }, seconds);
    });
    next();
  }
}
