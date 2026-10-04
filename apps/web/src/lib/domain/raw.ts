/** Lecture défensive des réponses JSON de l'API (jamais de plantage sur une forme inattendue). */
export type UnknownRecord = Record<string, unknown>;

export function rec(value: unknown): UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as UnknownRecord) : {};
}

export function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function bool(value: unknown): boolean {
  return value === true;
}

export function items<T>(raw: unknown, mapper: (item: unknown) => T): T[] {
  return Array.isArray(raw) ? raw.map(mapper) : [];
}

export function strings(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** Montant décimal en chaîne ; « 0.00 » si absent ou mal formé. */
export function amount(value: unknown): string {
  return typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) ? value : '0.00';
}

/** UUID (anti-injection de chemin pour les identifiants qui viennent d'une URL ou d'un formulaire). */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}
