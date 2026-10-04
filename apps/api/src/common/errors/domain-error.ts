import { HttpStatus } from '@nestjs/common';

export interface FieldIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface DomainErrorExtras {
  readonly errors?: readonly FieldIssue[];
  readonly requiredPermission?: string;
  readonly retryAfterSeconds?: number;
  /** Détails métier sérialisés tels quels dans le problème (ex. `candidates` d'un doublon). Sans donnée de santé détaillée. */
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * Erreur métier typée, traduite en problem+json par ProblemDetailsFilter (docs/03 §2.5).
 * `detail` ne doit jamais contenir de donnée de santé ni de donnée d'un autre tenant.
 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly title: string,
    readonly detail?: string,
    readonly extras: DomainErrorExtras = {},
  ) {
    super(detail ?? title);
    this.name = 'DomainError';
  }

  static unauthorized(detail = 'Authentification requise.'): DomainError {
    return new DomainError('unauthenticated', HttpStatus.UNAUTHORIZED, 'Unauthorized', detail);
  }

  static invalidCredentials(): DomainError {
    return new DomainError('invalid_credentials', HttpStatus.UNAUTHORIZED, 'Unauthorized', 'Identifiants invalides.');
  }

  static forbidden(code = 'permission_denied', detail = 'Action non autorisée.', requiredPermission?: string): DomainError {
    return new DomainError(code, HttpStatus.FORBIDDEN, 'Forbidden', detail, { requiredPermission });
  }

  /** Utilisé aussi pour une ressource d'un autre tenant : on ne révèle jamais son existence. */
  static notFound(resource = 'Ressource'): DomainError {
    return new DomainError('not_found', HttpStatus.NOT_FOUND, 'Not Found', `${resource} introuvable.`);
  }

  static conflict(code: string, detail: string, extras: DomainErrorExtras = {}): DomainError {
    return new DomainError(code, HttpStatus.CONFLICT, 'Conflict', detail, extras);
  }

  /** Ressource définitivement indisponible (ex. invitation expirée ou déjà utilisée). */
  static gone(code: string, detail: string): DomainError {
    return new DomainError(code, HttpStatus.GONE, 'Gone', detail);
  }

  /** `If-Match` fourni mais la version courante est différente (concurrence optimiste). */
  static preconditionFailed(detail = 'La ressource a été modifiée entre-temps.', errors?: readonly FieldIssue[]): DomainError {
    return new DomainError('precondition_failed', HttpStatus.PRECONDITION_FAILED, 'Precondition Failed', detail, { errors });
  }

  /** `If-Match` absent sur une opération qui l'exige. */
  static preconditionRequired(detail = 'L’en-tête If-Match est obligatoire pour cette opération.'): DomainError {
    return new DomainError('precondition_required', HttpStatus.PRECONDITION_REQUIRED, 'Precondition Required', detail);
  }

  static validation(errors: readonly FieldIssue[], detail = 'La requête contient des données invalides.'): DomainError {
    return new DomainError('validation_failed', HttpStatus.UNPROCESSABLE_ENTITY, 'Unprocessable Entity', detail, { errors });
  }

  static unprocessable(code: string, detail: string): DomainError {
    return new DomainError(code, HttpStatus.UNPROCESSABLE_ENTITY, 'Unprocessable Entity', detail);
  }

  static tooManyRequests(retryAfterSeconds: number): DomainError {
    return new DomainError('rate_limited', HttpStatus.TOO_MANY_REQUESTS, 'Too Many Requests', 'Trop de tentatives, réessayez plus tard.', {
      retryAfterSeconds,
    });
  }
}
