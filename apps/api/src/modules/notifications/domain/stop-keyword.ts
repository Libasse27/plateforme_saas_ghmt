const STOP_WORDS: ReadonlySet<string> = new Set(['STOP', 'ARRET']);
const STOP_PREFIX = 'STOP ';

/** Majuscules, sans accents ni ponctuation, espaces réduits. */
function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

/** Mot-clé de désinscription : `STOP` ou `ARRET` seuls, ou un message commençant par `STOP ` (docs/10 §5.7). */
export function isStopMessage(text: string): boolean {
  const normalized = normalize(text);
  return STOP_WORDS.has(normalized) || normalized.startsWith(STOP_PREFIX);
}
