import { DomainError } from '../errors/domain-error';
import { isUuid } from '../pipes/uuid.pipe';

export interface CursorPagination {
  readonly mode: 'cursor';
  readonly limit: number;
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/** Résultat paginé : l'intercepteur d'enveloppe place `pagination` dans `meta`. */
export class Page<T> {
  constructor(
    readonly items: readonly T[],
    readonly pagination: CursorPagination,
  ) {}

  /** Construit une page à partir de `limit + 1` lignes lues (détection de la page suivante). */
  static fromRows<R, T>(rows: readonly R[], limit: number, map: (row: R) => T, cursorOf: (row: R) => string): Page<T> {
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return new Page(pageRows.map(map), {
      mode: 'cursor',
      limit,
      hasMore,
      nextCursor: hasMore && last !== undefined ? encodeCursor(cursorOf(last)) : null,
    });
  }
}

export function encodeCursor(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): string | undefined {
  if (!cursor) return undefined;
  return Buffer.from(cursor, 'base64url').toString('utf8');
}

const INVALID_CURSOR = [{ path: 'cursor', code: 'invalid_cursor', message: 'Curseur invalide.' }] as const;

/** Curseur dont la valeur décodée est un UUID (listes triées par identifiant) ; sinon 422. */
export function decodeUuidCursor(cursor: string | undefined): string | undefined {
  const decoded = decodeCursor(cursor);
  if (decoded === undefined) return undefined;
  if (!isUuid(decoded)) throw DomainError.validation(INVALID_CURSOR);
  return decoded.toLowerCase();
}

/** Curseur composite `<date ISO>|<uuid>` (agenda) ; sinon 422. */
export function decodeDateIdCursor(cursor: string | undefined): { readonly date: Date; readonly id: string } | undefined {
  const decoded = decodeCursor(cursor);
  if (decoded === undefined) return undefined;
  const [rawDate, id, ...rest] = decoded.split('|');
  const date = new Date(rawDate ?? '');
  if (rest.length > 0 || !id || !isUuid(id) || Number.isNaN(date.getTime())) throw DomainError.validation(INVALID_CURSOR);
  return { date, id: id.toLowerCase() };
}
