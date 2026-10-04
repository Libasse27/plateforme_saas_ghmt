import { describe, expect, it } from 'vitest';
import { GRACE_WINDOW_MS, evaluateRefresh, type RefreshSnapshot } from './refresh-policy';

const NOW = new Date('2026-10-04T10:00:00.000Z');
const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);

function snapshot(overrides: Partial<RefreshSnapshot> = {}): RefreshSnapshot {
  return {
    tokenUsedAt: null,
    tokenExpiresAt: at(60_000),
    replacementUsedAt: undefined,
    sessionRevokedAt: null,
    sessionExpiresAt: at(3_600_000),
    ...overrides,
  };
}

describe('evaluateRefresh', () => {
  it('fait tourner un jeton valide et jamais utilisé', () => {
    expect(evaluateRefresh(snapshot(), NOW)).toBe('rotate');
  });

  it('refuse un jeton expiré', () => {
    expect(evaluateRefresh(snapshot({ tokenExpiresAt: at(-1) }), NOW)).toBe('invalid');
  });

  it('refuse un jeton dont la session est révoquée ou expirée', () => {
    expect(evaluateRefresh(snapshot({ sessionRevokedAt: at(-1000) }), NOW)).toBe('invalid');
    expect(evaluateRefresh(snapshot({ sessionExpiresAt: at(-1) }), NOW)).toBe('invalid');
  });

  it('tolère le rejeu d’un jeton consommé depuis moins de 10 s si son remplaçant n’a pas servi', () => {
    const s = snapshot({ tokenUsedAt: at(-(GRACE_WINDOW_MS - 1)), replacementUsedAt: null });
    expect(GRACE_WINDOW_MS).toBe(10_000);
    expect(evaluateRefresh(s, NOW)).toBe('grace');
  });

  it('détecte la réutilisation au-delà de la fenêtre de grâce', () => {
    const s = snapshot({ tokenUsedAt: at(-(GRACE_WINDOW_MS + 1)), replacementUsedAt: null });
    expect(evaluateRefresh(s, NOW)).toBe('reuse');
  });

  it('détecte la réutilisation si le remplaçant a déjà servi, même dans la fenêtre', () => {
    const s = snapshot({ tokenUsedAt: at(-1000), replacementUsedAt: at(-500) });
    expect(evaluateRefresh(s, NOW)).toBe('reuse');
  });

  it('détecte la réutilisation si le remplaçant est introuvable', () => {
    const s = snapshot({ tokenUsedAt: at(-1000), replacementUsedAt: undefined });
    expect(evaluateRefresh(s, NOW)).toBe('reuse');
  });

  it('traite un jeton consommé d’une session révoquée comme invalide, sans nouvelle alerte', () => {
    const s = snapshot({ tokenUsedAt: at(-1000), replacementUsedAt: null, sessionRevokedAt: at(-500) });
    expect(evaluateRefresh(s, NOW)).toBe('invalid');
  });
});
