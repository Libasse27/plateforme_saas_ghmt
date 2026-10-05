/** Conversions heure locale ↔ UTC par fuseau IANA, sans dépendance (Intl). Les règles datées des notifications en dépendent. */

export interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export interface LocalDateTime extends LocalDate {
  readonly hour: number;
  readonly minute: number;
}

const MS_PER_MINUTE = 60_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  formatters.set(timeZone, created);
  return created;
}

/** Composantes locales d'un instant dans un fuseau. */
export function zonedParts(instant: Date, timeZone: string): LocalDateTime & { readonly second: number } {
  const values: Record<string, number> = {};
  for (const part of partsFormatter(timeZone).formatToParts(instant)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return {
    year: values['year'] as number,
    month: values['month'] as number,
    day: values['day'] as number,
    hour: values['hour'] as number,
    minute: values['minute'] as number,
    second: values['second'] as number,
  };
}

/** Décalage (ms) du fuseau par rapport à UTC à un instant donné. */
function offsetMs(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** Instant UTC d'une heure locale (la première occurrence en cas de changement d'heure ambigu). */
export function zonedTimeToUtc(local: LocalDateTime, timeZone: string): Date {
  const naive = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const first = naive - offsetMs(new Date(naive), timeZone);
  const second = naive - offsetMs(new Date(first), timeZone);
  return new Date(second);
}

export function localDateOf(instant: Date, timeZone: string): LocalDate {
  const { year, month, day } = zonedParts(instant, timeZone);
  return { year, month, day };
}

export function addLocalDays(date: LocalDate, days: number): LocalDate {
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}

/** Minutes écoulées depuis minuit, heure locale. */
export function minutesOfDay(instant: Date, timeZone: string): number {
  const { hour, minute } = zonedParts(instant, timeZone);
  return hour * 60 + minute;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** `HH:MM` → minutes depuis minuit ; toute autre forme lève une erreur. */
export function parseHhmm(value: string): number {
  const match = HHMM.exec(value);
  if (!match) throw new Error(`Heure invalide : ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

export function minutesToLocalTime(minutes: number, date: LocalDate): LocalDateTime {
  return { ...date, hour: Math.floor(minutes / 60), minute: minutes % 60 };
}

export type NotificationLocaleCode = 'fr' | 'en';
const DATE_LOCALES: Readonly<Record<NotificationLocaleCode, string>> = { fr: 'fr-FR', en: 'en-GB' };

/** « mercredi 7 octobre » / « Wednesday 7 October », dans le fuseau du site. */
export function formatLocalDate(instant: Date, timeZone: string, locale: NotificationLocaleCode): string {
  const parts = new Intl.DateTimeFormat(DATE_LOCALES[locale], { timeZone, weekday: 'long', day: 'numeric', month: 'long' }).formatToParts(instant);
  const pick = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${pick('weekday')} ${pick('day')} ${pick('month')}`;
}

/** `HH:MM` locale. */
export function formatLocalTime(instant: Date, timeZone: string): string {
  const { hour, minute } = zonedParts(instant, timeZone);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export const MINUTE_MS = MS_PER_MINUTE;

/** Deux instants tombent-ils le même jour calendaire dans ce fuseau ? */
export function isSameLocalDay(a: Date, b: Date, timeZone: string): boolean {
  const left = localDateOf(a, timeZone);
  const right = localDateOf(b, timeZone);
  return left.year === right.year && left.month === right.month && left.day === right.day;
}
