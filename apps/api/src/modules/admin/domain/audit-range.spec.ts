import { describe, expect, it } from 'vitest';
import { DomainError } from '../../../common/errors/domain-error';
import { resolveAuditRange } from './audit-range';

const NOW = new Date('2026-10-05T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

describe('resolveAuditRange', () => {
  it('prend les 7 derniers jours par défaut', () => {
    const range = resolveAuditRange({}, NOW);

    expect(range.to).toEqual(NOW);
    expect(range.from).toEqual(new Date(NOW.getTime() - 7 * DAY_MS));
  });

  it('complète une borne manquante : from seul va jusqu’à maintenant, to seul remonte de 7 jours', () => {
    expect(resolveAuditRange({ from: '2026-09-30T00:00:00Z' }, NOW)).toEqual({ from: new Date('2026-09-30T00:00:00Z'), to: NOW });
    expect(resolveAuditRange({ to: '2026-10-01T00:00:00Z' }, NOW)).toEqual({
      from: new Date('2026-09-24T00:00:00Z'),
      to: new Date('2026-10-01T00:00:00Z'),
    });
  });

  it('accepte exactement 92 jours', () => {
    const range = resolveAuditRange({ from: '2026-07-05T12:00:00Z', to: '2026-10-05T12:00:00Z' }, NOW);

    expect(range.to.getTime() - range.from.getTime()).toBe(92 * DAY_MS);
  });

  it('refuse plus de 92 jours avec 422 range_too_large', () => {
    try {
      resolveAuditRange({ from: '2026-07-05T11:59:59Z', to: '2026-10-05T12:00:00Z' }, NOW);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).status).toBe(422);
      expect((error as DomainError).code).toBe('range_too_large');
    }
  });

  it('refuse une période inversée avec 422', () => {
    expect(() => resolveAuditRange({ from: '2026-10-05T00:00:00Z', to: '2026-10-01T00:00:00Z' }, NOW)).toThrow(DomainError);
  });

  it('refuse un from seul postérieur à maintenant (période inversée)', () => {
    expect(() => resolveAuditRange({ from: '2026-11-01T00:00:00Z' }, NOW)).toThrow(DomainError);
  });
});
