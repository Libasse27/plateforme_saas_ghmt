/** Termes interdits dans les messages (docs/10 §5.4, confidentialité) : médecine, pathologies, résultats, titres de médecin. */
export const FORBIDDEN_TERMS: readonly string[] = [
  'diagnostic',
  'motif',
  'pathologie',
  'maladie',
  'vih',
  'hiv',
  'sida',
  'aids',
  'ist',
  'std',
  'hépatite',
  'tuberculose',
  'psychiatr',
  'santé mentale',
  'addicto',
  'oncolog',
  'cancer',
  'chimio',
  'dialyse',
  'diabète',
  'grossesse',
  'prénatal',
  'ivg',
  'avortement',
  'contracept',
  'dépistage',
  'séropositi',
  'résultat',
  'result',
  'examen',
  'analyse',
  'ordonnance',
  'prescription',
  'médicament',
  'traitement',
  'dr',
  'docteur',
  'doctor',
  'maternité',
  'gynéco',
  'accouchement',
  'planning familial',
  'toxicomanie',
  'arv',
  'antirétroviral',
  'prep',
  'sérologie',
  'vaccin',
  'radiothérapie',
  'diagnosis',
  'hepatitis',
  'tuberculosis',
  'pregnancy',
  'pregnant',
  'disease',
  'mental health',
  'abortion',
  'antiretroviral',
  'vaccine',
  'treatment',
  'medication',
];

/** Sigles ambigus en début de mot (« prep » dans « preparer ») : reconnus comme mot entier seulement. */
const WHOLE_WORD_TERMS: ReadonlySet<string> = new Set(['prep', 'arv']);

/** Termes courts : reconnus uniquement comme mot entier (« dr » ne doit pas se déclencher dans « adresse »). */
const SHORT_TERM_MAX_LENGTH = 3;
const PLACEHOLDER = /\{\{[^}]*\}\}/g;

/** Minuscules, sans accents, pour comparer sans tenir compte de la casse ni des accents. */
export function normalizeForMatch(text: string): string {
  return text
    .replace(/\p{Cf}/gu, '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

/** Texte normalisé réduit à ses mots (lettres et chiffres) séparés par des espaces simples, borné par des espaces. */
function toPaddedWords(text: string): string {
  const words = normalizeForMatch(text.replace(PLACEHOLDER, ' ')).match(/[a-z0-9]+/g) ?? [];
  return ` ${words.join(' ')} `;
}

function matches(paddedWords: string, term: string): boolean {
  const normalized = normalizeForMatch(term);
  // Terme court : mot entier. Radical ou mot plus long : début de mot (« résultat » reconnaît « résultats »).
  return normalized.length <= SHORT_TERM_MAX_LENGTH || WHOLE_WORD_TERMS.has(normalized) ? paddedWords.includes(` ${normalized} `) : paddedWords.includes(` ${normalized}`);
}

/** Termes interdits trouvés dans le texte (variables `{{…}}` ignorées), dans l'ordre de la liste. */
export function findForbiddenTerms(text: string): string[] {
  const paddedWords = toPaddedWords(text);
  const found = FORBIDDEN_TERMS.filter((term) => matches(paddedWords, term));
  // « résultat » et son radical « result » désignent le même mot : un seul signalement.
  return found.filter((term) => !found.some((other) => other !== term && normalizeForMatch(other).startsWith(normalizeForMatch(term))));
}

/** Le texte contient-il le nom d'un service ? (comparaison normalisée, sous-chaîne). */
export function containsServiceName(text: string, serviceName: string): boolean {
  const words = (value: string): string => (normalizeForMatch(value.replace(PLACEHOLDER, ' ')).match(/[a-z0-9]+/g) ?? []).join(' ');
  const needle = words(serviceName);
  return needle !== '' && words(text).includes(needle);
}
