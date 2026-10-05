export const MASKED_VALUE = '[masqué]';
const TRUNCATED_VALUE = '[tronqué]';
const MAX_STRING_LENGTH = 200;
const MAX_PATIENT_IDS = 50;
const MAX_DEPTH = 10;
const REASON_CODE_PATTERN = /^[a-z0-9_.:-]{1,64}$/;

/** Clés pouvant porter un texte libre ou une donnée identifiante : masquées à toute profondeur (docs/10 §6), comparées sans casse. */
const MASKED_KEYS: ReadonlySet<string> = new Set(
  [
    'forceReason', 'cancelReason', 'comment', 'note', 'notes', 'description', 'label', 'printLabel', 'voidReason', 'text', 'body',
    'subject', 'motif', 'diagnosis', 'address', 'phone', 'email', 'nationalId', 'firstName', 'lastName', 'fullName', 'birthDate',
    'q', 'query', 'term',
  ].map((key) => key.toLowerCase()),
);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeReason(value: unknown): unknown {
  if (value === null) return null;
  return typeof value === 'string' && REASON_CODE_PATTERN.test(value) ? value : MASKED_VALUE;
}

/** `patientIds` borné à 50 éléments ; `patientIdsCount` conserve le total réel. */
function sanitizePatientIds(value: unknown, depth: number): Record<string, unknown> {
  if (!Array.isArray(value)) return { patientIds: MASKED_VALUE };
  return { patientIds: value.slice(0, MAX_PATIENT_IDS).map((item) => sanitizeValue(item, depth + 1)), patientIdsCount: value.length };
}

function sanitizeEntry(key: string, value: unknown, depth: number): Record<string, unknown> {
  if (key === 'patientIds') return sanitizePatientIds(value, depth);
  if (key === 'reason') return { [key]: sanitizeReason(value) };
  if (MASKED_KEYS.has(key.toLowerCase())) return { [key]: MASKED_VALUE };
  return { [key]: sanitizeValue(value, depth + 1) };
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return TRUNCATED_VALUE;
  if (typeof value === 'string') return value.length > MAX_STRING_LENGTH ? value.slice(0, MAX_STRING_LENGTH) : value;
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, depth + 1));
  if (isPlainObject(value)) {
    return Object.entries(value).reduce<Record<string, unknown>>((acc, [key, entry]) => ({ ...acc, ...sanitizeEntry(key, entry, depth) }), {});
  }
  return value;
}

/**
 * Assainit le champ `changes` d'un événement d'audit avant toute restitution (liste ou export) : aucune donnée clinique
 * ni texte libre. Renvoie un nouvel objet ; l'entrée n'est jamais modifiée.
 */
export function sanitizeAuditChanges(changes: unknown): Record<string, unknown> | null {
  if (!isPlainObject(changes)) return null;
  return sanitizeValue(changes, 0) as Record<string, unknown>;
}
