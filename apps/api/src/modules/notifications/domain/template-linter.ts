import { NOTIFICATION_TYPES, type NotificationChannel, type NotificationTypeCode } from '@ghmt/shared';
import { containsServiceName, findForbiddenTerms } from './privacy-terms';
import { SAMPLE_VALUES } from './sample-values';
import { SMS_MAX_SEGMENTS, analyzeSms } from './sms-encoding';
import { extractVariables, findMalformedPlaceholders, renderLenient } from './template-engine';

export type TemplateIssueCode = 'unknown_variable' | 'forbidden_term' | 'service_name' | 'too_many_segments' | 'too_long' | 'subject_required' | 'subject_forbidden' | 'link_forbidden' | 'phone_forbidden' | 'stop_required';

export interface TemplateIssue {
  readonly path: 'subject' | 'body';
  readonly code: TemplateIssueCode;
  readonly message: string;
}

export interface LintInput {
  readonly typeCode: NotificationTypeCode;
  readonly channel: NotificationChannel;
  readonly subject?: string;
  readonly body: string;
  /** Noms des services du tenant (`tenant.departments.name`, 4 caractères ou plus). */
  readonly serviceNames: readonly string[];
  /** Translittération des SMS active (réglage du tenant) : détermine l'encodage et donc les segments. */
  readonly transliterate: boolean;
}

const MIN_SERVICE_NAME_LENGTH = 4;
const LIMITS = {
  email: { subject: 150, body: 5000 },
  inapp: { subject: 120, body: 500 },
} as const;

type Field = 'subject' | 'body';

const issue = (path: Field, code: TemplateIssueCode, message: string): TemplateIssue => ({ path, code, message });

function subjectIssues(channel: NotificationChannel, subject: string | undefined): TemplateIssue[] {
  const present = subject !== undefined && subject.trim() !== '';
  if (channel === 'sms') return present ? [issue('subject', 'subject_forbidden', 'Un SMS n’a pas de sujet.')] : [];
  return present ? [] : [issue('subject', 'subject_required', 'Le sujet est obligatoire pour ce canal.')];
}

function variableIssues(field: Field, text: string, allowed: readonly string[]): TemplateIssue[] {
  const unknown = extractVariables(text).filter((name) => !allowed.includes(name));
  const malformed = findMalformedPlaceholders(text);
  return [...unknown, ...malformed].map((name) => issue(field, 'unknown_variable', `Variable non autorisée pour ce type de message : ${name}`));
}

function contentIssues(field: Field, text: string, serviceNames: readonly string[]): TemplateIssue[] {
  const terms = findForbiddenTerms(text).map((term) => issue(field, 'forbidden_term', `Terme interdit (confidentialité) : « ${term} »`));
  const services = serviceNames
    .filter((name) => name.trim().length >= MIN_SERVICE_NAME_LENGTH && containsServiceName(text, name))
    .map(() => issue(field, 'service_name', 'Le nom d’un service de l’établissement ne doit pas figurer dans un message.'));
  return [...terms, ...(services.length > 0 ? [services[0] as TemplateIssue] : [])];
}

const LINK_PATTERN = /https?:\/\/|\bwww\./i;
const PHONE_PATTERN = /\+\s?\d[\d\s.-]{6,}\d|\b\d{2,3}[\s.-]\d{2,3}[\s.-]\d{2}[\s.-]\d{2}\b|\b\d{7,}\b/;
const PLACEHOLDERS = /\{\{[^}]*\}\}/g;
const STOP_REMINDERS: ReadonlySet<string> = new Set(['appointment.reminder_d1', 'appointment.reminder_h2']);

/** Messages patients : aucun lien (hameçonnage) ni numéro de téléphone ; SMS de rappel : mention STOP obligatoire. */
function patientContentIssues(input: LintInput): TemplateIssue[] {
  if (NOTIFICATION_TYPES[input.typeCode].recipient !== 'patient') return [];
  const issues: TemplateIssue[] = [];
  for (const [field, text] of [['subject', input.subject ?? ''], ['body', input.body]] as const) {
    const bare = text.replace(PLACEHOLDERS, ' ');
    if (LINK_PATTERN.test(bare)) issues.push(issue(field, 'link_forbidden', 'Aucun lien n’est autorisé dans un message destiné à un patient.'));
    if (PHONE_PATTERN.test(bare)) issues.push(issue(field, 'phone_forbidden', 'Aucun numéro de téléphone n’est autorisé dans un message destiné à un patient.'));
  }
  const needsStop = input.channel === 'sms' && STOP_REMINDERS.has(input.typeCode);
  if (needsStop && !/\bstop\b/i.test(input.body.replace(PLACEHOLDERS, ' '))) issues.push(issue('body', 'stop_required', 'Un SMS de rappel doit indiquer comment se désinscrire (STOP).'));
  return issues;
}

function lengthIssues(input: LintInput): TemplateIssue[] {
  const body = renderLenient(input.body, SAMPLE_VALUES);
  if (input.channel === 'sms') {
    const { segments } = analyzeSms(body, { transliterate: input.transliterate });
    return segments > SMS_MAX_SEGMENTS ? [issue('body', 'too_many_segments', `Le SMS dépasse ${SMS_MAX_SEGMENTS} segments (${segments}).`)] : [];
  }
  const limits = LIMITS[input.channel];
  const issues: TemplateIssue[] = [];
  const subject = renderLenient(input.subject ?? '', SAMPLE_VALUES);
  if (subject.length > limits.subject) issues.push(issue('subject', 'too_long', `Le sujet dépasse ${limits.subject} caractères.`));
  if (body.length > limits.body) issues.push(issue('body', 'too_long', `Le corps dépasse ${limits.body} caractères.`));
  return issues;
}

/**
 * Linter de confidentialité (docs/10 §5.4) : variables de la liste blanche du type, termes cliniques interdits, noms de
 * service, sujet selon le canal et longueurs avec des valeurs de longueur maximale. Bloquant pour les surcharges.
 */
export function lintTemplate(input: LintInput): TemplateIssue[] {
  const allowed = NOTIFICATION_TYPES[input.typeCode].variables;
  const fields: readonly (readonly [Field, string])[] = [
    ['subject', input.subject ?? ''],
    ['body', input.body],
  ];
  const perField = fields.flatMap(([field, text]) => [...variableIssues(field, text, allowed), ...contentIssues(field, text, input.serviceNames)]);
  return [...subjectIssues(input.channel, input.subject), ...perField, ...patientContentIssues(input), ...lengthIssues(input)];
}
