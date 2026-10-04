import type { FieldIssue } from './types';

export interface ApiErrorInit {
  readonly status: number;
  readonly code: string;
  readonly title?: string;
  readonly detail?: string;
  readonly errors?: readonly FieldIssue[];
  readonly requestId?: string;
  readonly extras?: Readonly<Record<string, unknown>>;
}

/** Erreur API normalisée (problem+json, docs/03 §2.5) ; status 0 = pas de réponse. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string | undefined;
  readonly detail: string | undefined;
  readonly errors: readonly FieldIssue[];
  readonly requestId: string | undefined;
  readonly extras: Readonly<Record<string, unknown>>;

  constructor(init: ApiErrorInit) {
    super(init.detail ?? init.title ?? init.code);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.title = init.title;
    this.detail = init.detail;
    this.errors = init.errors ?? [];
    this.requestId = init.requestId;
    this.extras = init.extras ?? {};
  }

  static network(): ApiError {
    return new ApiError({ status: 0, code: 'network_error' });
  }

  static timeout(): ApiError {
    return new ApiError({ status: 0, code: 'timeout' });
  }

  static unauthenticated(): ApiError {
    return new ApiError({ status: 401, code: 'unauthenticated' });
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}
