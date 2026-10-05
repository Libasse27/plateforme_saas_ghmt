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
