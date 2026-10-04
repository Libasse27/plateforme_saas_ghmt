import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { type Observable, map } from 'rxjs';
import { RequestContext } from '../context/request-context';
import { Page } from '../pagination/page';

export interface Envelope<T> {
  readonly success: true;
  readonly data: T;
  readonly error: null;
  readonly meta: Readonly<Record<string, unknown>>;
}

/** Enveloppe `{ success, data, error, meta }` (docs/03 §2.2). `undefined` ⇒ 204 sans corps. */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly context: RequestContext) {}

  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((result: unknown) => {
        if (result === undefined) return undefined;
        const meta = { requestId: this.context.requestId, timestamp: new Date().toISOString() };
        if (result instanceof Page) {
          return { success: true, data: result.items, error: null, meta: { ...meta, pagination: result.pagination } };
        }
        return { success: true, data: result, error: null, meta } satisfies Envelope<unknown>;
      }),
    );
  }
}
