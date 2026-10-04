import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RequestContext } from '../context/request-context';
import { DomainError } from '../errors/domain-error';

const PROBLEM_BASE_URI = 'https://api.ghmt.app/problems/';

interface ProblemBody {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code: string;
  requestId?: string;
  [extension: string]: unknown;
}

/** Codes PostgreSQL / Prisma traduits en erreurs métier sans divulguer le SQL. */
function fromDatabaseError(err: unknown): DomainError | undefined {
  const e = err as { code?: string; meta?: { code?: string; driverAdapterError?: { cause?: { originalCode?: string } } } };
  const pgCode = e?.meta?.driverAdapterError?.cause?.originalCode ?? e?.meta?.code;
  if (e?.code === 'P2002' || pgCode === '23505') return DomainError.conflict('duplicate', 'Un enregistrement identique existe déjà.');
  if (e?.code === 'P2025') return DomainError.notFound();
  if (pgCode === '23P01') return DomainError.conflict('slot_unavailable', 'Le créneau chevauche un rendez-vous existant.');
  if (e?.code === 'P2003' || pgCode === '23503') return DomainError.unprocessable('invalid_reference', 'Une référence fournie est invalide.');
  if (pgCode === '42501') return DomainError.forbidden('row_security', 'Action non autorisée.');
  return undefined;
}

const LOG_MESSAGE_MAX_LENGTH = 200;

const PRISMA_CODE = /^P\d{4}$/;

function isPrismaError(e: { name?: unknown; code?: unknown } | null | undefined): boolean {
  return (typeof e?.name === 'string' && e.name.startsWith('Prisma')) || (typeof e?.code === 'string' && PRISMA_CODE.test(e.code));
}

/**
 * Résumé journalisable d'une erreur inattendue : nom, code et message tronqué uniquement.
 * Jamais l'objet d'erreur entier (requêtes SQL, paramètres, corps de requête pouvant contenir des données de santé).
 * Pour une erreur Prisma, le message peut citer des valeurs de colonnes : seuls `name` et `code` sont conservés.
 */
export function summarizeError(exception: unknown): { name: string; code: string | null; message?: string } {
  const e = exception as { name?: unknown; code?: unknown; message?: unknown } | null | undefined;
  const name = typeof e?.name === 'string' ? e.name : typeof exception;
  const code = typeof e?.code === 'string' ? e.code : null;
  if (isPrismaError(e)) return { name, code };
  return { name, code, message: (typeof e?.message === 'string' ? e.message : '').slice(0, LOG_MESSAGE_MAX_LENGTH) };
}

function toDomainError(exception: unknown): DomainError {
  if (exception instanceof DomainError) return exception;
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const code = status === HttpStatus.TOO_MANY_REQUESTS ? 'rate_limited' : HttpStatus[status]?.toLowerCase() ?? 'http_error';
    return new DomainError(code, status, HttpStatus[status] ?? 'Error', exception.message);
  }
  return fromDatabaseError(exception) ?? new DomainError('internal_error', 500, 'Internal Server Error', 'Une erreur interne est survenue.');
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  constructor(private readonly context: RequestContext) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const error = toDomainError(exception);
    const requestId = this.context.requestId;

    if (error.status >= 500) {
      // Résumé minimal côté serveur uniquement (jamais renvoyé au client, jamais l'erreur brute).
      this.logger.error({ requestId, error: summarizeError(exception) }, 'Unhandled error');
    }

    const problem: ProblemBody = {
      type: `${PROBLEM_BASE_URI}${error.code}`,
      title: error.title,
      status: error.status,
      detail: error.detail,
      instance: req.originalUrl?.split('?')[0],
      code: error.code,
      requestId,
      ...Object.fromEntries(Object.entries(error.extras).filter(([, v]) => v !== undefined)),
    };

    if (error.extras.retryAfterSeconds) res.setHeader('Retry-After', String(error.extras.retryAfterSeconds));

    const wantsBareProblem = (req.header('accept') ?? '').includes('application/problem+json');
    const body = wantsBareProblem
      ? problem
      : { ...problem, success: false, data: null, error: problem, meta: { requestId, timestamp: new Date().toISOString() } };

    res.status(error.status).type('application/problem+json').send(JSON.stringify(body));
  }
}
