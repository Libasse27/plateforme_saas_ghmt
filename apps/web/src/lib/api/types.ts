/** Contrats de l'enveloppe API (docs/03 §2.2, §2.3, §2.5). */
export interface CursorPagination {
  readonly mode?: string;
  readonly limit?: number;
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface ApiMeta {
  readonly requestId?: string;
  readonly timestamp?: string;
  readonly pagination?: CursorPagination;
  readonly warnings?: readonly string[];
}

export interface ApiSuccess<T> {
  readonly data: T;
  readonly meta: ApiMeta;
  readonly status: number;
}

export interface FieldIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface TokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Durée de vie du jeton d'accès en secondes. */
  readonly expiresIn?: number;
}
