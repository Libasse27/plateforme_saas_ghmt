import { describe, expect, it } from 'vitest';
import { DISPERSION_MAX_MS, deferForQuietHours, dispersionMs, isWithinQuietHours } from './quiet-hours';
import { formatLocalDate, formatLocalTime, minutesOfDay, parseHhmm, zonedTimeToUtc } from './zoned-time';

const NIGHT = { start: '21:00', end: '07:00' };
const DAYTIME = { start: '12:00', end: '14:00' };

describe('zoned-time', () => {
  it('convertit une heure locale en instant UTC pour Dakar (UTC+0), Douala (UTC+1) et Lubumbashi (UTC+2)', () => {
    const local = { year: 2026, month: 10, day: 7, hour: 10, minute: 0 };

    expect(zonedTimeToUtc(local, 'Africa/Dakar').toISOString()).toBe('2026-10-07T10:00:00.000Z');
    expect(zonedTimeToUtc(local, 'Africa/Douala').toISOString()).toBe('2026-10-07T09:00:00.000Z');
    expect(zonedTimeToUtc(local, 'Africa/Lubumbashi').toISOString()).toBe('2026-10-07T08:00:00.000Z');
  });

  it('gère le passage au jour précédent (minuit local)', () => {
    const local = { year: 2026, month: 10, day: 7, hour: 0, minute: 30 };

    expect(zonedTimeToUtc(local, 'Africa/Lubumbashi').toISOString()).toBe('2026-10-06T22:30:00.000Z');
  });

  it('calcule les minutes écoulées depuis minuit local', () => {
    const instant = new Date('2026-10-07T20:30:00Z');

    expect(minutesOfDay(instant, 'Africa/Dakar')).toBe(20 * 60 + 30);
    expect(minutesOfDay(instant, 'Africa/Douala')).toBe(21 * 60 + 30);
    expect(minutesOfDay(instant, 'Africa/Lubumbashi')).toBe(22 * 60 + 30);
  });

  it('analyse HH:MM et refuse un format invalide', () => {
    expect(parseHhmm('07:05')).toBe(7 * 60 + 5);
    expect(() => parseHhmm('7h05')).toThrow();
    expect(() => parseHhmm('24:00')).toThrow();
  });

  it('formate la date et l’heure dans la langue et le fuseau du site', () => {
    const instant = new Date('2026-10-07T09:30:00Z');

    expect(formatLocalDate(instant, 'Africa/Douala', 'fr')).toBe('mercredi 7 octobre');
    expect(formatLocalDate(instant, 'Africa/Douala', 'en')).toBe('Wednesday 7 October');
    expect(formatLocalTime(instant, 'Africa/Douala')).toBe('10:30');
    expect(formatLocalTime(new Date('2026-10-07T23:30:00Z'), 'Africa/Lubumbashi')).toBe('01:30');
  });
});

describe('isWithinQuietHours', () => {
  it('traite une plage qui traverse minuit (21:00 → 07:00)', () => {
    expect(isWithinQuietHours(new Date('2026-10-07T21:00:00Z'), 'Africa/Dakar', NIGHT)).toBe(true);
    expect(isWithinQuietHours(new Date('2026-10-07T23:59:00Z'), 'Africa/Dakar', NIGHT)).toBe(true);
    expect(isWithinQuietHours(new Date('2026-10-07T06:59:00Z'), 'Africa/Dakar', NIGHT)).toBe(true);
    expect(isWithinQuietHours(new Date('2026-10-07T07:00:00Z'), 'Africa/Dakar', NIGHT)).toBe(false);
    expect(isWithinQuietHours(new Date('2026-10-07T12:00:00Z'), 'Africa/Dakar', NIGHT)).toBe(false);
    expect(isWithinQuietHours(new Date('2026-10-07T20:59:00Z'), 'Africa/Dakar', NIGHT)).toBe(false);
  });

  it('traite une plage dans la même journée (12:00 → 14:00)', () => {
    expect(isWithinQuietHours(new Date('2026-10-07T12:00:00Z'), 'Africa/Dakar', DAYTIME)).toBe(true);
    expect(isWithinQuietHours(new Date('2026-10-07T13:59:00Z'), 'Africa/Dakar', DAYTIME)).toBe(true);
    expect(isWithinQuietHours(new Date('2026-10-07T14:00:00Z'), 'Africa/Dakar', DAYTIME)).toBe(false);
  });

  it('applique le fuseau local : 20:30 UTC est la nuit à Douala (21:30) mais pas à Dakar', () => {
    const instant = new Date('2026-10-07T20:30:00Z');

    expect(isWithinQuietHours(instant, 'Africa/Dakar', NIGHT)).toBe(false);
    expect(isWithinQuietHours(instant, 'Africa/Douala', NIGHT)).toBe(true);
    expect(isWithinQuietHours(instant, 'Africa/Lubumbashi', NIGHT)).toBe(true);
  });
});

describe('deferForQuietHours', () => {
  const ID = '0197a3c0-0000-7000-8000-0000000000a1';

  it('retourne null hors plage silencieuse', () => {
    expect(deferForQuietHours(new Date('2026-10-07T12:00:00Z'), 'Africa/Dakar', NIGHT, ID)).toBeNull();
  });

  it('reporte à la fin de plage du lendemain (07:00 locale) plus la dispersion', () => {
    const at = deferForQuietHours(new Date('2026-10-07T22:00:00Z'), 'Africa/Dakar', NIGHT, ID);

    expect(at).not.toBeNull();
    const delta = at!.getTime() - new Date('2026-10-08T07:00:00Z').getTime();
    expect(delta).toBe(dispersionMs(ID));
  });

  it('reporte à la fin de plage du jour même après minuit', () => {
    const at = deferForQuietHours(new Date('2026-10-08T03:00:00Z'), 'Africa/Dakar', NIGHT, ID);

    expect(at!.getTime() - new Date('2026-10-08T07:00:00Z').getTime()).toBe(dispersionMs(ID));
  });

  it('calcule la fin de plage dans le fuseau du site (Douala 07:00 = 06:00 UTC, Lubumbashi = 05:00 UTC)', () => {
    const douala = deferForQuietHours(new Date('2026-10-07T21:30:00Z'), 'Africa/Douala', NIGHT, ID);
    const lubumbashi = deferForQuietHours(new Date('2026-10-07T21:30:00Z'), 'Africa/Lubumbashi', NIGHT, ID);

    expect(douala!.getTime() - new Date('2026-10-08T06:00:00Z').getTime()).toBe(dispersionMs(ID));
    expect(lubumbashi!.getTime() - new Date('2026-10-08T05:00:00Z').getTime()).toBe(dispersionMs(ID));
  });

  it('reporte une plage diurne à sa fin du jour même', () => {
    const at = deferForQuietHours(new Date('2026-10-07T12:30:00Z'), 'Africa/Dakar', DAYTIME, ID);

    expect(at!.getTime() - new Date('2026-10-07T14:00:00Z').getTime()).toBe(dispersionMs(ID));
  });
});

describe('dispersionMs', () => {
  it('est déterministe et comprise entre 0 et 10 minutes', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `0197a3c0-0000-7000-8000-${String(i).padStart(12, '0')}`);
    const values = ids.map(dispersionMs);

    expect(values.every((v) => v >= 0 && v <= DISPERSION_MAX_MS)).toBe(true);
    expect(DISPERSION_MAX_MS).toBe(10 * 60_000);
    expect(ids.map(dispersionMs)).toEqual(values);
    expect(new Set(values).size).toBeGreaterThan(30);
  });
});
