export type SmsEncoding = 'GSM7' | 'UCS2';

/** Plafond de segments d'un SMS de GHMT (docs/10 §5.4). */
export const SMS_MAX_SEGMENTS = 3;

const GSM7_SINGLE_UNITS = 160;
const GSM7_MULTI_UNITS = 153;
const UCS2_SINGLE_UNITS = 70;
const UCS2_MULTI_UNITS = 67;

/** Alphabet de base GSM 03.38 (le retour chariot et le saut de ligne en font partie). */
const GSM7_BASIC = new Set(
  Array.from(
    '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
  ),
);
/** Table d'extension : chaque caractère coûte deux septets. */
const GSM7_EXTENSION = new Set(Array.from('\f^{}\\[~]|€'));

const PUNCTUATION_MAP: Readonly<Record<string, string>> = {
  '’': "'",
  '‘': "'",
  '‚': ',',
  '“': '"',
  '”': '"',
  '«': '"',
  '»': '"',
  '–': '-',
  '—': '-',
  '…': '...',
  ' ': ' ',
  ' ': ' ',
  œ: 'oe',
  Œ: 'OE',
};

const isGsm7 = (char: string): boolean => GSM7_BASIC.has(char) || GSM7_EXTENSION.has(char);

function transliterateChar(char: string): string {
  if (isGsm7(char)) return char;
  const mapped = PUNCTUATION_MAP[char];
  if (mapped !== undefined) return mapped;
  const base = char.normalize('NFD').replace(/\p{M}/gu, '');
  return base !== '' && Array.from(base).every(isGsm7) ? base : char;
}

/** Remplace les caractères hors GSM-7 par leur équivalent ASCII ; un caractère sans équivalent est conservé. */
export function transliterateForSms(text: string): string {
  return Array.from(text).map(transliterateChar).join('');
}

export interface SmsAnalysis {
  /** Texte réellement envoyé (translittéré si demandé). */
  readonly text: string;
  readonly encoding: SmsEncoding;
  /** Septets (GSM-7) ou unités UTF-16 (UCS-2). */
  readonly units: number;
  readonly segments: number;
}

function gsm7Units(text: string): number {
  return Array.from(text).reduce((total, char) => total + (GSM7_EXTENSION.has(char) ? 2 : 1), 0);
}

function segmentsOf(units: number, single: number, multi: number): number {
  if (units === 0) return 0;
  return units <= single ? 1 : Math.ceil(units / multi);
}

/** Encodage (GSM-7 si tous les caractères y figurent, sinon UCS-2) et nombre de segments (160/153 ou 70/67). */
export function analyzeSms(text: string, options: { readonly transliterate: boolean }): SmsAnalysis {
  const sent = options.transliterate ? transliterateForSms(text) : text;
  if (Array.from(sent).every(isGsm7)) {
    const units = gsm7Units(sent);
    return { text: sent, encoding: 'GSM7', units, segments: segmentsOf(units, GSM7_SINGLE_UNITS, GSM7_MULTI_UNITS) };
  }
  const units = sent.length;
  return { text: sent, encoding: 'UCS2', units, segments: segmentsOf(units, UCS2_SINGLE_UNITS, UCS2_MULTI_UNITS) };
}
