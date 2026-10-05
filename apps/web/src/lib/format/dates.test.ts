import { describe, expect, it } from 'vitest';
import { addDays, buildSlot, dayRange, formatBirthDate, formatLongDay, formatTime, isDayString, isValidTimeZone, parseTime, todayInZone } from './dates';

describe('jours', () => {
  it('valide les dates calendaires', () => {
    expect(isDayString('2026-10-04')).toBe(true);
    expect(isDayString('2026-02-30')).toBe(false);
    expect(isDayString('04/10/2026')).toBe(false);
    expect(isDayString(undefined)).toBe(false);
    expect(isDayString('')).toBe(false);
  });
  it('addDays gère les fins de mois et d\'année', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('todayInZone applique le fuseau', () => {
    const instant = new Date('2026-10-04T23:30:00Z');
    expect(todayInZone('Africa/Dakar', instant)).toBe('2026-10-04');
    expect(todayInZone('Africa/Douala', instant)).toBe('2026-10-05');
  });
  it('formate les dates en français', () => {
    expect(formatLongDay('2026-10-04')).toBe('dimanche 4 octobre 2026');
    expect(formatBirthDate('1988-03-14')).toBe('14/03/1988');
    expect(formatBirthDate('1988-03-14T00:00:00Z')).toBe('14/03/1988');
    expect(formatBirthDate(undefined)).toBe('');
    expect(formatBirthDate('n/a')).toBe('');
  });
});

describe('fuseaux', () => {
  it('reconnaît les fuseaux valides', () => {
    expect(isValidTimeZone('Africa/Douala')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
  it('dayRange décale selon le fuseau (Douala = UTC+1)', () => {
    expect(dayRange('2026-10-04', 'Africa/Douala')).toEqual({ from: '2026-10-03T23:00:00.000Z', to: '2026-10-04T23:00:00.000Z' });
    expect(dayRange('2026-10-04', 'Africa/Dakar')).toEqual({ from: '2026-10-04T00:00:00.000Z', to: '2026-10-05T00:00:00.000Z' });
  });
  it('dayRange respecte l\'heure d\'été d\'un fuseau européen (jour de 23 h)', () => {
    const { from, to } = dayRange('2026-03-29', 'Europe/Paris');
    expect((Date.parse(to) - Date.parse(from)) / 3_600_000).toBe(23);
  });
  it('formatTime affiche l\'heure locale', () => {
    expect(formatTime('2026-10-04T08:30:00Z', 'Africa/Douala')).toBe('09:30');
    expect(formatTime('pas une date', 'Africa/Douala')).toBe('--:--');
  });
});

describe('buildSlot', () => {
  it('construit un créneau UTC à partir de l\'heure locale', () => {
    expect(buildSlot('2026-10-10', '09:30', 30, 'Africa/Douala')).toEqual({
      startsAt: '2026-10-10T08:30:00.000Z',
      endsAt: '2026-10-10T09:00:00.000Z',
    });
  });
  it('rejette les entrées invalides', () => {
    expect(buildSlot('2026-10-10', '25:00', 30, 'Africa/Dakar')).toBeNull();
    expect(buildSlot('2026-13-10', '09:00', 30, 'Africa/Dakar')).toBeNull();
    expect(buildSlot('2026-10-10', '09:00', 0, 'Africa/Dakar')).toBeNull();
    expect(buildSlot('2026-10-10', '09:00', Number.NaN, 'Africa/Dakar')).toBeNull();
  });
  it('parseTime', () => {
    expect(parseTime('07:05')).toBe(425);
    expect(parseTime('7:5')).toBeNull();
  });
});

describe('formatDay / formatDateTime / daysUntil', () => {
  it('formate dans le fuseau de l\'établissement', async () => {
    const { formatDay, formatDateTime } = await import('./dates');
    expect(formatDay('2026-11-03T23:30:00.000Z', 'Africa/Dakar')).toBe('03/11/2026');
    expect(formatDay('2026-11-03T23:30:00.000Z', 'Africa/Douala')).toBe('04/11/2026');
    expect(formatDateTime('2026-11-03T13:05:00.000Z', 'Africa/Dakar')).toBe('03/11/2026 13:05');
    expect(formatDay(null, 'Africa/Dakar')).toBe('-');
    expect(formatDateTime('pas une date', 'Africa/Dakar')).toBe('-');
  });
  it('compte les jours restants', async () => {
    const { daysUntil } = await import('./dates');
    const now = new Date('2026-10-04T10:00:00.000Z');
    expect(daysUntil('2026-10-14T09:00:00.000Z', now)).toBe(10);
    expect(daysUntil('2026-10-14T11:00:00.000Z', now)).toBe(11);
    expect(daysUntil('2026-10-01T00:00:00.000Z', now)).toBe(0);
    expect(daysUntil(null, now)).toBeNull();
    expect(daysUntil('x', now)).toBeNull();
  });
});
