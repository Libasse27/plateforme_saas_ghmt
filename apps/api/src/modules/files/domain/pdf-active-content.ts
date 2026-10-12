import { inflateSync } from 'node:zlib';

/**
 * Noms PDF refusés (docs/13 D8) : JavaScript, lancement de programme, pièces jointes, médias riches, formulaires XFA et
 * chiffrement (le contenu chiffré ne peut pas être inspecté). Comparés après décodage des échappements `#xx`.
 * `/OpenAction` et `/AA` restent acceptés : les PDF scannés légitimes en portent.
 */
const FORBIDDEN_NAMES: ReadonlySet<string> = new Set(['JS', 'JavaScript', 'Launch', 'EmbeddedFile', 'EmbeddedFiles', 'RichMedia', 'XFA', 'Encrypt']);
/** Filtres d'image non décodés mais acceptés (scans) : ils ne portent pas de contenu actif. */
const IMAGE_FILTERS: ReadonlySet<string> = new Set(['DCTDecode', 'JPXDecode', 'CCITTFaxDecode', 'JBIG2Decode']);
const FLATE_FILTER = 'FlateDecode';

/** Nom PDF : `/` suivi de caractères réguliers (ni blanc ni délimiteur). */
const NAME_PATTERN = /\/([^\s/[\]<>(){}%]*)/g;
const FILTER_ENTRY = /\/Filter\s*(\[[^\]]*\]|\/[^\s/[\]<>(){}%]+)/;
const FILTER_KEY = /\/Filter(?![A-Za-z])/;
const STREAM_KEYWORD = 'stream';
const END_STREAM_KEYWORD = 'endstream';
/** Fenêtre d'analyse du dictionnaire qui précède un flux (borne le coût par flux). */
const DICTIONARY_WINDOW = 8 * 1024;
/** Nombre maximal de flux examinés : au-delà, refus (échec fermé). */
export const MAX_PDF_STREAMS = 2_000;
/** Plafond de décompression d'un flux : protège contre les bombes de décompression. */
const MAX_INFLATED_BYTES = 32 * 1024 * 1024;
/** Budget cumulé de décompression pour tout le document. */
export const MAX_TOTAL_INFLATED_BYTES = 64 * 1024 * 1024;

function decodeName(raw: string): string {
  return raw.replace(/#([0-9A-Fa-f]{2})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

function containsForbiddenName(text: string): boolean {
  for (const match of text.matchAll(NAME_PATTERN)) {
    if (FORBIDDEN_NAMES.has(decodeName(match[1] ?? ''))) return true;
  }
  return false;
}

/**
 * Filtres déclarés par le dictionnaire du flux ; `undefined` si `/Filter` est présent mais illisible (référence indirecte,
 * syntaxe inattendue) : le flux est alors refusé.
 */
function declaredFilters(dictionary: string): readonly string[] | undefined {
  if (!FILTER_KEY.test(dictionary)) return [];
  const entry = FILTER_ENTRY.exec(dictionary)?.[1];
  if (!entry) return undefined;
  const names = [...entry.matchAll(NAME_PATTERN)].map((match) => decodeName(match[1] ?? ''));
  return names.length > 0 ? names : undefined;
}

/** Dictionnaire du flux commençant à `keywordIndex` : texte entre le dernier `obj` et le mot-clé, dans la fenêtre bornée. */
function dictionaryBefore(text: string, keywordIndex: number, floor: number): string {
  const window = text.slice(Math.max(floor, keywordIndex - DICTIONARY_WINDOW), keywordIndex);
  const objectStart = window.lastIndexOf('obj');
  return objectStart < 0 ? window : window.slice(objectStart + 3);
}

/** Position du début des données du flux si `keywordIndex` est un vrai mot-clé `stream` (suivi de CRLF ou LF), sinon -1. */
function streamDataStart(text: string, keywordIndex: number): number {
  if (keywordIndex >= 3 && text.startsWith('end', keywordIndex - 3)) return -1;
  const after = keywordIndex + STREAM_KEYWORD.length;
  if (text.startsWith('\r\n', after)) return after + 2;
  return text.charCodeAt(after) === 0x0a ? after + 1 : -1;
}

/**
 * PDF refusé (échec fermé) s'il contient du contenu actif ou ne peut pas être inspecté en entier : noms interdits (dans la
 * structure, dans un flux sans filtre ou dans un flux FlateDecode décompressé), PDF chiffré, flux illisible ou trop
 * volumineux une fois décompressé, filtre non géré, trop de flux. Balayage en une passe : la recherche de `endstream`
 * reprend après le flux précédent (coût linéaire).
 * Les données encore compressées (images, Flate avant décompression) ne sont jamais lues comme du texte : sur des octets
 * quasi aléatoires, `/JS` suivi d'un délimiteur apparaît environ une fois tous les 250 Mo, soit des refus à tort de scans.
 */
export function pdfHasActiveContent(content: Buffer): boolean {
  const text = content.toString('latin1');

  let streams = 0;
  let inflatedTotal = 0;
  let position = 0;
  let previousEnd = 0;
  for (;;) {
    const keywordIndex = text.indexOf(STREAM_KEYWORD, position);
    if (keywordIndex < 0) return containsForbiddenName(text.slice(previousEnd));
    position = keywordIndex + STREAM_KEYWORD.length;
    const start = streamDataStart(text, keywordIndex);
    if (start < 0) continue;

    streams += 1;
    if (streams > MAX_PDF_STREAMS) return true;
    const end = text.indexOf(END_STREAM_KEYWORD, start);
    if (end < 0) return true;
    // Structure entre le flux précédent et celui-ci (dictionnaires, objets, actions) : toujours analysée.
    if (containsForbiddenName(text.slice(previousEnd, start))) return true;
    const filters = declaredFilters(dictionaryBefore(text, keywordIndex, previousEnd));
    position = end + END_STREAM_KEYWORD.length;
    previousEnd = position;

    if (!filters) return true;
    if (filters.length === 0) {
      if (containsForbiddenName(text.slice(start, end))) return true; // flux sans filtre : texte en clair
      continue;
    }
    if (filters.length === 1 && IMAGE_FILTERS.has(filters[0]!)) continue;
    if (filters.length !== 1 || filters[0] !== FLATE_FILTER) return true;

    let inflated: Buffer;
    try {
      const limit = Math.min(MAX_INFLATED_BYTES, MAX_TOTAL_INFLATED_BYTES - inflatedTotal);
      inflated = inflateSync(content.subarray(start, end), { maxOutputLength: Math.max(limit, 1) });
    } catch {
      return true; // flux corrompu, ou plus grand que la limite : non inspectable
    }
    inflatedTotal += inflated.length;
    if (inflatedTotal > MAX_TOTAL_INFLATED_BYTES || containsForbiddenName(inflated.toString('latin1'))) return true;
  }
}
