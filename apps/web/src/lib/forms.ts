import type { ZodError } from 'zod';

/** État renvoyé par les Server Actions de formulaire (useActionState). */
export interface FormState {
  readonly ok?: boolean;
  readonly message?: string;
  readonly fieldErrors?: Readonly<Record<string, string>>;
  /** Valeurs saisies (jamais de mot de passe) pour repeupler le formulaire après erreur. */
  readonly values?: Readonly<Record<string, string>>;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export const EMPTY_FORM_STATE: FormState = {};

const SENSITIVE_FIELDS: ReadonlySet<string> = new Set(['password', 'confirmPassword', 'admin.password', 'admin.confirmPassword', 'currentPassword', 'newPassword', 'code']);
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

type Nested = { [key: string]: string | Nested };

/** Aplatit un FormData en { nom: valeur } en ignorant les champs techniques `$ACTION_*` de Next. */
export function formDataToFlat(formData: FormData): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (key.startsWith('$') || typeof value !== 'string') continue;
    flat[key] = value;
  }
  return flat;
}

/** Transforme { 'admin.email': 'x' } en { admin: { email: 'x' } } ; les chaînes vides sont omises. */
export function nestFlat(flat: Readonly<Record<string, string>>): Nested {
  const root: Nested = {};
  for (const [key, raw] of Object.entries(flat)) {
    const value = raw.trim();
    if (value === '') continue;
    const segments = key.split('.');
    if (segments.some((s) => FORBIDDEN_KEYS.has(s))) continue;
    let cursor = root;
    segments.slice(0, -1).forEach((segment) => {
      const next = cursor[segment];
      if (typeof next === 'object') {
        cursor = next;
      } else {
        const created: Nested = {};
        cursor[segment] = created;
        cursor = created;
      }
    });
    const last = segments[segments.length - 1];
    if (last !== undefined) cursor[last] = value;
  }
  return root;
}

export function publicValues(flat: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(flat).filter(([key]) => !SENSITIVE_FIELDS.has(key)));
}

function defaultMessage(issue: ZodError['issues'][number]): string {
  switch (issue.code) {
    case 'invalid_type':
      return 'Ce champ est obligatoire ou de type incorrect.';
    case 'too_small':
      return issue.origin === 'string' && Number(issue.minimum) <= 1
        ? 'Ce champ est obligatoire.'
        : issue.origin === 'string'
          ? `Au moins ${String(issue.minimum)} caractères sont requis.`
          : `La valeur doit être au moins ${String(issue.minimum)}.`;
    case 'too_big':
      return issue.origin === 'string' ? `Au plus ${String(issue.maximum)} caractères sont autorisés.` : `La valeur doit être au plus ${String(issue.maximum)}.`;
    case 'invalid_format':
      return issue.format === 'email' ? 'Adresse e-mail invalide.' : issue.format === 'date' ? 'Date invalide (format AAAA-MM-JJ).' : 'Format invalide.';
    case 'invalid_value':
      return 'Valeur non reconnue.';
    default:
      return 'Valeur invalide.';
  }
}

const ENGLISH_DEFAULT = /^(Invalid|Too |Required|Expected|Unrecognized|Input )/;

/** Message français : on conserve les messages personnalisés des schémas, on traduit les messages Zod par défaut. */
export function issueMessage(issue: ZodError['issues'][number]): string {
  return ENGLISH_DEFAULT.test(issue.message) ? defaultMessage(issue) : issue.message;
}

export function fieldErrorsFromZod(error: ZodError): Record<string, string> {
  const result: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.');
    if (!(path in result)) result[path] = issueMessage(issue);
  }
  return result;
}

/** N'accepte qu'un chemin interne (anti redirection ouverte) ; sinon la racine. */
export function safeNextPath(candidate: string | null | undefined): string {
  if (!candidate || !candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\')) return '/';
  if (/[\u0000-\u001f]/.test(candidate)) return '/';
  return candidate;
}
