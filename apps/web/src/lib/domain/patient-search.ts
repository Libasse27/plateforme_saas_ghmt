import { normalizePhone } from './phone';

export interface PatientSearchBody {
  readonly q?: string;
  readonly phone?: string;
  readonly ipp?: string;
  readonly limit: number;
  readonly cursor?: string;
}

export type SearchBodyResult =
  | { readonly ok: true; readonly body: PatientSearchBody }
  | { readonly ok: false; readonly error: string };

export const SEARCH_PAGE_SIZE = 20;
const MIN_TERM_LENGTH = 2;
const MAX_TERM_LENGTH = 100;
const MAX_CURSOR_LENGTH = 200;
const MIN_PHONE_DIGITS = 6;
const IPP = /^P\d{2}-\d{7}$/i;
const PHONE_LIKE = /^\+?[\d\s().-]+$/;

/**
 * Construit le corps de POST /patients/search (C1) à partir de la saisie : IPP, téléphone
 * (international ou local, normalisé avec l'indicatif du pays du tenant) ou texte.
 * Le curseur est opaque et vient de la réponse précédente de l'API.
 */
export function buildSearchBody(raw: string | undefined, countryCode: string | undefined, cursor?: string): SearchBodyResult {
  const term = raw?.trim() ?? '';
  if (term.length === 0) return { ok: false, error: 'Saisissez un nom, un téléphone ou un numéro de dossier.' };
  if (term.length > MAX_TERM_LENGTH) return { ok: false, error: 'La recherche ne peut pas dépasser 100 caractères.' };
  if (cursor && cursor.length > MAX_CURSOR_LENGTH) return { ok: false, error: 'Page de résultats invalide. Relancez la recherche.' };
  const page = cursor ? { limit: SEARCH_PAGE_SIZE, cursor } : { limit: SEARCH_PAGE_SIZE };

  if (IPP.test(term)) return { ok: true, body: { ipp: term.toUpperCase(), ...page } };

  const digitCount = term.replace(/\D/g, '').length;
  if (PHONE_LIKE.test(term) && (term.startsWith('+') || digitCount >= MIN_PHONE_DIGITS)) {
    const phone = normalizePhone(term, countryCode);
    return phone.ok ? { ok: true, body: { phone: phone.e164, ...page } } : { ok: false, error: phone.error };
  }
  if (term.length < MIN_TERM_LENGTH) return { ok: false, error: 'Saisissez au moins 2 caractères.' };
  return { ok: true, body: { q: term, ...page } };
}
