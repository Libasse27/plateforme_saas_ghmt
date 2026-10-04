import { describe, expect, it } from 'vitest';
import { etagOf, requireIfMatch } from './if-match';

describe('requireIfMatch', () => {
  it('lit les formes "3", W/"3" et 3', () => {
    expect(requireIfMatch('"3"')).toBe(3);
    expect(requireIfMatch('W/"12"')).toBe(12);
    expect(requireIfMatch(' 7 ')).toBe(7);
  });

  it('refuse l’absence de l’en-tête par 428 precondition_required', () => {
    for (const header of [undefined, '', '  ']) {
      expect(() => requireIfMatch(header)).toThrowError(expect.objectContaining({ status: 428, code: 'precondition_required' }));
    }
  });

  it('refuse un en-tête mal formé par 422 invalid_if_match', () => {
    for (const header of ['abc', '"1.5"', '*', '"-1"', '12345678901']) {
      expect(() => requireIfMatch(header), header).toThrowError(expect.objectContaining({ status: 422, code: 'invalid_if_match' }));
    }
  });

  it('formate l’ETag entre guillemets', () => {
    expect(etagOf(4)).toBe('"4"');
  });
});
