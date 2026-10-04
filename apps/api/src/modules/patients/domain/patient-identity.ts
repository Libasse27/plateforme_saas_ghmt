const IPP_SEQUENCE_DIGITS = 7;
const SQL_WILDCARDS = /[%_\\]/g;

/** IPP au format `P{YY}-{séquence sur 7 chiffres}`, ex. P26-0000042. */
export function formatIpp(sequence: number | bigint, now: Date = new Date()): string {
  const year = String(now.getUTCFullYear() % 100).padStart(2, '0');
  return `P${year}-${sequence.toString().padStart(IPP_SEQUENCE_DIGITS, '0')}`;
}

/** Minuscules, sans accents, espaces réduits : base de la recherche et de la détection de doublons. */
export function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Colonne `search_name` : nom puis prénom normalisés. */
export function buildSearchName(lastName: string, firstName: string): string {
  return normalizeName(`${lastName} ${firstName}`);
}

/** `search_name` avec nom et prénom inversés : détecte la saisie « Awa Diop » pour « Diop Awa ». */
export function buildSwappedSearchName(lastName: string, firstName: string): string {
  return normalizeName(`${firstName} ${lastName}`);
}

export const ESTIMATED_BIRTH_YEAR_TOLERANCE = 2;

/** Fenêtre [1er janvier, 31 décembre] des années `année ± tolérance`, pour une date de naissance estimée. */
export function birthYearWindow(birthDate: Date, tolerance: number = ESTIMATED_BIRTH_YEAR_TOLERANCE): { from: Date; to: Date } {
  const year = birthDate.getUTCFullYear();
  return { from: new Date(Date.UTC(year - tolerance, 0, 1)), to: new Date(Date.UTC(year + tolerance, 11, 31)) };
}

/** Terme de recherche sûr pour un ILIKE : normalisé, sans jokers SQL. */
export function toSearchPattern(term: string): string {
  return normalizeName(term.replace(SQL_WILDCARDS, ''));
}

/** Nom d'affichage « Prénom NOM » (nom de famille en majuscules). */
export function formatPatientFullName(firstName: string, lastName: string): string {
  return `${firstName} ${lastName.toLocaleUpperCase('fr')}`.trim();
}

/** N° de pièce d'identité canonique pour l'index aveugle : sans espaces ni tirets, en majuscules. */
export function normalizeNationalId(value: string): string {
  return value.replace(/[\s-]+/g, '').toUpperCase();
}
