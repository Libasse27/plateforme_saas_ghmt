import { describe, expect, it } from 'vitest';
import { amount, bool, isUuid, items, num, numOrNull, rec, str, strOrNull, strings } from './raw';

describe('lecture défensive', () => {
  it('rec, str, num, bool tolèrent les valeurs inattendues', () => {
    expect(rec(null)).toEqual({});
    expect(rec([1])).toEqual({});
    expect(rec({ a: 1 })).toEqual({ a: 1 });
    expect(str(3, 'x')).toBe('x');
    expect(str('a')).toBe('a');
    expect(strOrNull('')).toBeNull();
    expect(strOrNull('a')).toBe('a');
    expect(num(Number.NaN, 7)).toBe(7);
    expect(num(4)).toBe(4);
    expect(numOrNull(null)).toBeNull();
    expect(numOrNull(0)).toBe(0);
    expect(bool(true)).toBe(true);
    expect(bool('true')).toBe(false);
  });
  it('items, strings, amount', () => {
    expect(items('x', (v) => v)).toEqual([]);
    expect(items([1, 2], (v) => Number(v) * 2)).toEqual([2, 4]);
    expect(strings(['a', 1, 'b'])).toEqual(['a', 'b']);
    expect(strings(null)).toEqual([]);
    expect(amount('25000.00')).toBe('25000.00');
    expect(amount('x')).toBe('0.00');
    expect(amount(12)).toBe('0.00');
  });
  it('isUuid', () => {
    expect(isUuid('3f2b8c1e-1a2b-4c3d-8e9f-0123456789ab')).toBe(true);
    expect(isUuid('../etc')).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});
