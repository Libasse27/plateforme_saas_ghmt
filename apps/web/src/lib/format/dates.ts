const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('fr-FR', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function isDayString(value: string | undefined | null): value is string {
  if (!value) return false;
  const match = DAY_PATTERN.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** Décalage (ms) du fuseau par rapport à UTC à l'instant donné. */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** Instant UTC correspondant à une date/heure locale du fuseau. */
function zonedToInstant(day: string, minutesOfDay: number, timeZone: string): number {
  const [y, m, d] = (DAY_PATTERN.exec(day) as RegExpExecArray).slice(1).map(Number) as [number, number, number];
  const localAsUtc = Date.UTC(y, m - 1, d) + minutesOfDay * MINUTE_MS;
  const firstGuess = localAsUtc - zoneOffsetMs(localAsUtc, timeZone);
  return localAsUtc - zoneOffsetMs(firstGuess, timeZone);
}

export function todayInZone(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return parts;
}

export function addDays(day: string, delta: number): string {
  const [y, m, d] = (DAY_PATTERN.exec(day) as RegExpExecArray).slice(1).map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + delta * DAY_MS).toISOString().slice(0, 10);
}

/** Bornes [from, to[ d'un jour civil du fuseau, en ISO UTC. */
export function dayRange(day: string, timeZone: string): { from: string; to: string } {
  const from = zonedToInstant(day, 0, timeZone);
  const to = zonedToInstant(addDays(day, 1), 0, timeZone);
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

export function parseTime(value: string): number | null {
  const match = TIME_PATTERN.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** Combine jour + heure locale + durée en créneau ISO UTC ; null si l'entrée est invalide. */
export function buildSlot(day: string, time: string, durationMinutes: number, timeZone: string): { startsAt: string; endsAt: string } | null {
  const minutes = parseTime(time);
  if (!isDayString(day) || minutes === null || !Number.isFinite(durationMinutes) || durationMinutes <= 0) return null;
  const start = zonedToInstant(day, minutes, timeZone);
  return { startsAt: new Date(start).toISOString(), endsAt: new Date(start + durationMinutes * MINUTE_MS).toISOString() };
}

export function formatTime(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--';
  return new Intl.DateTimeFormat('fr-FR', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

export function formatLongDay(day: string): string {
  const [y, m, d] = (DAY_PATTERN.exec(day) as RegExpExecArray).slice(1).map(Number) as [number, number, number];
  return new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
}

export function formatBirthDate(value: string | undefined): string {
  if (!value || !isDayString(value.slice(0, 10))) return '';
  const [y, m, d] = value.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

/** Jour civil du fuseau au format JJ/MM/AAAA ; « - » si la date est absente ou invalide. */
export function formatDay(iso: string | null | undefined, timeZone: string): string {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('fr-FR', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
}

/** Date et heure du fuseau : « 03/11/2026 14:05 ». */
export function formatDateTime(iso: string | null | undefined, timeZone: string): string {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return '-';
  return `${formatDay(iso, timeZone)} ${formatTime(iso as string, timeZone)}`;
}

/** Nombre de jours restants jusqu'à l'échéance (arrondi au supérieur, jamais négatif) ; null si la date est invalide. */
export function daysUntil(iso: string | null | undefined, now: Date): number | null {
  const target = iso ? new Date(iso).getTime() : Number.NaN;
  if (Number.isNaN(target)) return null;
  return Math.max(0, Math.ceil((target - now.getTime()) / DAY_MS));
}
