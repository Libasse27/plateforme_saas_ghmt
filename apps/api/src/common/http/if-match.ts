import { DomainError } from '../errors/domain-error';

const IF_MATCH_PATTERN = /^(?:W\/)?"?(\d{1,9})"?$/;

/**
 * Lit `If-Match: "<rowVersion>"` (ou `W/"3"`, ou `3`).
 * Absent ⇒ 428 `precondition_required` ; mal formé ⇒ 422 `invalid_if_match`.
 */
export function requireIfMatch(header: string | undefined): number {
  if (header === undefined || header.trim() === '') throw DomainError.preconditionRequired();
  const match = IF_MATCH_PATTERN.exec(header.trim());
  if (!match) throw DomainError.unprocessable('invalid_if_match', 'En-tête If-Match invalide.');
  return Number(match[1]);
}

/** Valeur d'en-tête ETag pour une version de ligne. */
export function etagOf(rowVersion: number): string {
  return `"${rowVersion}"`;
}
