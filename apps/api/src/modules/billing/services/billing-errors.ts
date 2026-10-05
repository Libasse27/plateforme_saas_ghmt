import { DomainError, type FieldIssue } from '../../../common/errors/domain-error';

/** Violation de contrainte d'unicité (code Prisma P2002). */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}

/** Référence invalide dans un corps valide (site, rendez-vous, session, article) : 422 sur le champ concerné. */
export function refIssue(path: string, message: string, code = 'not_found'): DomainError {
  const issue: FieldIssue = { path, code, message };
  return DomainError.validation([issue]);
}
