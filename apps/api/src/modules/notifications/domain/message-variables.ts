import { findForbiddenTerms } from './privacy-terms';
import { daysLate } from './dunning-schedule';
import { formatLocalDate, formatLocalTime, type NotificationLocaleCode } from './zoned-time';

type Values = Record<string, string>;

const DECIMAL_SEPARATOR: Readonly<Record<NotificationLocaleCode, { group: string; decimal: string }>> = {
  fr: { group: ' ', decimal: ',' },
  en: { group: ',', decimal: '.' },
};

/** `25000.00` → `25 000 XOF` : milliers groupés, décimales nulles retirées (aucun flottant, le montant reste une chaîne). */
export function formatAmount(amount: string, currency: string, locale: NotificationLocaleCode): string {
  const [integerPart = '0', fraction = ''] = amount.split('.');
  const { group, decimal } = DECIMAL_SEPARATOR[locale];
  const grouped = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  const decimals = /^0*$/.test(fraction) ? '' : `${decimal}${fraction}`;
  return `${grouped}${decimals} ${currency}`;
}

const LONG_DATE_LOCALES: Readonly<Record<NotificationLocaleCode, string>> = { fr: 'fr-FR', en: 'en-GB' };

/** « 20 octobre 2026 » / « 20 October 2026 ». */
export function formatLongDate(instant: Date, timeZone: string, locale: NotificationLocaleCode): string {
  const parts = new Intl.DateTimeFormat(LONG_DATE_LOCALES[locale], { timeZone, day: 'numeric', month: 'long', year: 'numeric' }).formatToParts(instant);
  const pick = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${pick('day')} ${pick('month')} ${pick('year')}`;
}

/** `etablissement.nom` = nom d'expéditeur réglé, à défaut le nom de l'établissement (docs/10 §5.9). */
/** Un nom saisi avant le contrôle (ou contourné) qui contiendrait un terme interdit n'est jamais affiché : repli sur le nom de l'établissement. */
const safeName = (value: string | null, fallback: string): string => (value !== null && findForbiddenTerms(value).length === 0 ? value : fallback);
const displayName = (facts: { tenantName: string; senderDisplayName: string | null }): string => safeName(facts.senderDisplayName, facts.tenantName);

export interface AppointmentFacts {
  readonly tenantName: string;
  readonly senderDisplayName: string | null;
  readonly siteName: string;
  readonly patientFirstName: string;
  readonly startsAt: Date;
  readonly timeZone: string;
  readonly locale: NotificationLocaleCode;
}

export function appointmentVariables(facts: AppointmentFacts): Values {
  return {
    'etablissement.nom': displayName(facts),
    'site.nom': safeName(facts.siteName, facts.tenantName),
    'patient.prenom': facts.patientFirstName,
    'rdv.date': formatLocalDate(facts.startsAt, facts.timeZone, facts.locale),
    'rdv.heure': formatLocalTime(facts.startsAt, facts.timeZone),
  };
}

export interface InvoiceContext {
  readonly invoiceNumber: string;
  readonly amount: string;
  readonly currency: string;
  readonly dueAt: string;
  readonly offsetDays: number;
}

export interface InvoiceFacts {
  readonly tenantName: string;
  readonly senderDisplayName: string | null;
  readonly timeZone: string;
  readonly locale: NotificationLocaleCode;
  readonly now: Date;
  readonly link: string;
}

export function invoiceVariables(context: InvoiceContext, facts: InvoiceFacts): Values {
  const dueAt = new Date(context.dueAt);
  return {
    'etablissement.nom': displayName(facts),
    'facture.numero': context.invoiceNumber,
    'facture.montant': formatAmount(context.amount, context.currency, facts.locale),
    'facture.echeance': formatLongDate(dueAt, facts.timeZone, facts.locale),
    'facture.jours_retard': String(daysLate(dueAt, facts.now)),
    lien: facts.link,
  };
}

export interface QuotaContext {
  readonly month: string;
  readonly thresholdPercent: number;
  readonly limit: number;
}

export function quotaVariables(context: QuotaContext, facts: { tenantName: string; senderDisplayName: string | null; link: string }): Values {
  return {
    'etablissement.nom': displayName(facts),
    'quota.pourcentage': String(context.thresholdPercent),
    'quota.limite': String(context.limit),
    lien: facts.link,
  };
}

export type SecurityScopeType = 'tenant' | 'site' | 'department';

/** Contexte d'une alerte de sécurité : seuls les champs utiles au type sont renseignés. */
export interface SecurityContext {
  readonly targetUserId?: string;
  readonly targetName?: string;
  readonly roleName?: string;
  readonly scopeType?: SecurityScopeType;
  readonly actorName?: string;
}

const SCOPE_LABEL: Readonly<Record<NotificationLocaleCode, Record<SecurityScopeType, string>>> = {
  fr: { tenant: 'l’établissement', site: 'un site', department: 'un service' },
  en: { tenant: 'the establishment', site: 'a site', department: 'a department' },
};

const SECURITY_CONSOLE_PATH = '/administration/securite';

/** Chemin (relatif) de la fiche utilisateur. */
export function securityUserPath(targetUserId: string): string {
  return `/administration/utilisateurs/${targetUserId}`;
}

/** Lien d'une alerte : la console de sécurité pour les réseaux et la politique, sinon la fiche de la personne visée. */
export function securityLinkPath(typeCode: string, context: SecurityContext): string {
  if (typeCode === 'security.trusted_network_changed' || typeCode === 'security.policy_changed') return SECURITY_CONSOLE_PATH;
  return context.targetUserId ? securityUserPath(context.targetUserId) : SECURITY_CONSOLE_PATH;
}

/** Seul le TYPE de portée est transmis, jamais le nom d'un site ou d'un service (docs/11 D10). */
export function securityVariables(
  context: SecurityContext,
  facts: { tenantName: string; senderDisplayName: string | null; webUrl: string; locale: NotificationLocaleCode; typeCode?: string },
): Values {
  const scope = SCOPE_LABEL[facts.locale];
  return {
    'etablissement.nom': displayName(facts),
    'utilisateur.nom': context.targetName ?? '',
    'role.nom': context.roleName ?? '',
    'portee.type': scope[context.scopeType ?? 'tenant'] ?? scope.tenant,
    'acteur.nom': context.actorName ?? '',
    lien: `${facts.webUrl.replace(/\/+$/, '')}${securityLinkPath(facts.typeCode ?? 'security.sensitive_role_assigned', context)}`,
  };
}
