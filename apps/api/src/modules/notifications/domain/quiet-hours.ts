import { createHash } from 'node:crypto';
import { MINUTE_MS, addLocalDays, localDateOf, minutesOfDay, minutesToLocalTime, parseHhmm, zonedTimeToUtc } from './zoned-time';

export interface QuietHours {
  /** `HH:MM` local. */
  readonly start: string;
  readonly end: string;
}

/** Dispersion maximale ajoutée à la fin de plage : évite que tous les SMS reportés partent à la même seconde. */
export const DISPERSION_MAX_MS = 10 * MINUTE_MS;

/** Plage [début, fin) en heure locale ; elle peut traverser minuit (21:00 → 07:00). */
export function isWithinQuietHours(instant: Date, timeZone: string, hours: QuietHours): boolean {
  const minutes = minutesOfDay(instant, timeZone);
  const start = parseHhmm(hours.start);
  const end = parseHhmm(hours.end);
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/** Instant (UTC) de la prochaine fin de plage, ou null hors plage. */
export function quietHoursEnd(instant: Date, timeZone: string, hours: QuietHours): Date | null {
  if (!isWithinQuietHours(instant, timeZone, hours)) return null;
  const minutes = minutesOfDay(instant, timeZone);
  const start = parseHhmm(hours.start);
  const end = parseHhmm(hours.end);
  const endsTomorrow = start > end && minutes >= start;
  const endDay = addLocalDays(localDateOf(instant, timeZone), endsTomorrow ? 1 : 0);
  return zonedTimeToUtc(minutesToLocalTime(end, endDay), timeZone);
}

/** Dispersion déterministe (0 à 10 min) dérivée de l'identifiant : un rejeu donne le même report. */
export function dispersionMs(id: string): number {
  const digest = createHash('sha256').update(id).digest();
  return digest.readUInt32BE(0) % (DISPERSION_MAX_MS + 1);
}

/** Nouvel instant d'envoi d'un SMS tombant en plage silencieuse (fin de plage + dispersion), ou null s'il peut partir. */
export function deferForQuietHours(instant: Date, timeZone: string, hours: QuietHours, id: string): Date | null {
  const end = quietHoursEnd(instant, timeZone, hours);
  return end === null ? null : new Date(end.getTime() + dispersionMs(id));
}

/** Une heure locale `HH:MM` tombe-t-elle dans la plage silencieuse ? (contrôle des réglages) */
export function isLocalTimeInQuietHours(time: string, hours: QuietHours): boolean {
  const minutes = parseHhmm(time);
  const start = parseHhmm(hours.start);
  const end = parseHhmm(hours.end);
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}
