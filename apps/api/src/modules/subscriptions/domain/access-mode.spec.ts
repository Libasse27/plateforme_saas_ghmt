import { describe, expect, it } from 'vitest';
import { accessModeOf, trialDaysLeft } from './access-mode';

describe('accessModeOf', () => {
  it.each([
    ['trial', 'normal'],
    ['active', 'normal'],
    ['past_due', 'normal'],
    ['grace', 'restricted'],
    ['suspended', 'continuity'],
    ['cancelled', 'continuity'],
    ['expired', 'continuity'],
  ] as const)('%s ⇒ %s', (status, mode) => {
    expect(accessModeOf(status)).toBe(mode);
  });
});

describe('trialDaysLeft', () => {
  const now = new Date('2026-10-05T10:00:00Z');
  it('arrondit au jour supérieur pendant l’essai', () => {
    expect(trialDaysLeft('trial', new Date('2026-10-15T22:00:00Z'), now)).toBe(11);
  });
  it('ne descend jamais sous zéro et vaut null hors essai', () => {
    expect(trialDaysLeft('trial', new Date('2026-10-01T00:00:00Z'), now)).toBe(0);
    expect(trialDaysLeft('active', new Date('2026-10-15T00:00:00Z'), now)).toBeNull();
    expect(trialDaysLeft('trial', null, now)).toBeNull();
  });
});
