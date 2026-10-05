import { localDateKey } from '../../../common/time/local-date';

export interface DayBounds {
  /** Jour calendaire local (AAAA-MM-JJ). */
  readonly date: string;
  /** Minuit local (inclus), en instant UTC. */
  readonly start: Date;
  /** Minuit local du lendemain (exclu). */
  readonly end: Date;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Décalage (ms) entre l'heure locale du fuseau et UTC à un instant donné. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(instant);
  const part = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** Instant UTC de minuit local pour un jour `AAAA-MM-JJ` (deux passes : robuste aux changements d'heure). */
function localMidnightUtc(dateKey: string, timeZone: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number) as [number, number, number];
  const naive = Date.UTC(year, month - 1, day);
  const first = naive - zoneOffsetMs(new Date(naive), timeZone);
  return new Date(naive - zoneOffsetMs(new Date(first), timeZone));
}

function nextDateKey(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day) + MS_PER_DAY).toISOString().slice(0, 10);
}

/** Bornes `[début, fin[` du jour local de `instant` dans le fuseau IANA du tenant. */
export function dayBounds(instant: Date, timeZone: string): DayBounds {
  const date = localDateKey(instant, timeZone);
  return { date, start: localMidnightUtc(date, timeZone), end: localMidnightUtc(nextDateKey(date), timeZone) };
}
