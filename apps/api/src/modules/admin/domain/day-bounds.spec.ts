import { describe, expect, it } from 'vitest';
import { dayBounds } from './day-bounds';

describe('dayBounds', () => {
  it('Africa/Dakar (UTC+0) : le jour UTC', () => {
    const bounds = dayBounds(new Date('2026-10-05T23:59:59.999Z'), 'Africa/Dakar');

    expect(bounds).toEqual({ date: '2026-10-05', start: new Date('2026-10-05T00:00:00Z'), end: new Date('2026-10-06T00:00:00Z') });
  });

  it('Africa/Douala (UTC+1) : 23:59 locale reste dans le jour, 00:00 locale ouvre le suivant', () => {
    const lastMinute = dayBounds(new Date('2026-10-05T22:59:00Z'), 'Africa/Douala');
    const midnight = dayBounds(new Date('2026-10-05T23:00:00Z'), 'Africa/Douala');

    expect(lastMinute.date).toBe('2026-10-05');
    expect(lastMinute.start).toEqual(new Date('2026-10-04T23:00:00Z'));
    expect(lastMinute.end).toEqual(new Date('2026-10-05T23:00:00Z'));
    expect(midnight.date).toBe('2026-10-06');
    expect(midnight.start).toEqual(new Date('2026-10-05T23:00:00Z'));
  });

  it('Africa/Lubumbashi (UTC+2) : un instant tardif en UTC appartient déjà au lendemain local', () => {
    const bounds = dayBounds(new Date('2026-10-05T22:30:00Z'), 'Africa/Lubumbashi');

    expect(bounds.date).toBe('2026-10-06');
    expect(bounds.start).toEqual(new Date('2026-10-05T22:00:00Z'));
    expect(bounds.end).toEqual(new Date('2026-10-06T22:00:00Z'));
  });

  it('fuseau à décalage négatif (America/Guayaquil, UTC-5)', () => {
    const bounds = dayBounds(new Date('2026-10-05T03:00:00Z'), 'America/Guayaquil');

    expect(bounds.date).toBe('2026-10-04');
    expect(bounds.start).toEqual(new Date('2026-10-04T05:00:00Z'));
  });

  it('gère un changement d’heure (Europe/Paris, 25 octobre 2026 : jour de 25 h)', () => {
    const bounds = dayBounds(new Date('2026-10-25T12:00:00Z'), 'Europe/Paris');

    expect(bounds.start).toEqual(new Date('2026-10-24T22:00:00Z'));
    expect(bounds.end).toEqual(new Date('2026-10-25T23:00:00Z'));
  });
});
