import { describe, expect, it } from 'vitest';
import { decodeDateIdCursor, decodeUuidCursor, encodeCursor } from './page';

const UUID = '0197a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

describe('décodage des curseurs (L3)', () => {
  it('renvoie undefined sans curseur', () => {
    expect(decodeUuidCursor(undefined)).toBeUndefined();
    expect(decodeUuidCursor('')).toBeUndefined();
    expect(decodeDateIdCursor(undefined)).toBeUndefined();
  });

  it('accepte un curseur UUID et le normalise en minuscules', () => {
    expect(decodeUuidCursor(encodeCursor(UUID.toUpperCase()))).toBe(UUID);
  });

  it('rejette un curseur qui n’est pas un UUID par 422', () => {
    for (const cursor of [encodeCursor('pas-un-uuid'), 'zzz', encodeCursor(`${UUID}'; --`)]) {
      expect(() => decodeUuidCursor(cursor), cursor).toThrowError(expect.objectContaining({ status: 422 }));
    }
  });

  it('décode le curseur composite date|uuid et rejette les autres formes', () => {
    const date = '2027-03-01T08:00:00.000Z';
    expect(decodeDateIdCursor(encodeCursor(`${date}|${UUID}`))).toEqual({ date: new Date(date), id: UUID });
    for (const bad of ['x|y', `${date}`, `nope|${UUID}`, `${date}|${UUID}|extra`]) {
      expect(() => decodeDateIdCursor(encodeCursor(bad)), bad).toThrowError(expect.objectContaining({ status: 422 }));
    }
  });
});
