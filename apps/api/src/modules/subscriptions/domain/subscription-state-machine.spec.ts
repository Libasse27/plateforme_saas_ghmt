import { describe, expect, it } from 'vitest';
import { SUBSCRIPTION_STATUSES, type SubscriptionStatus } from '@ghmt/shared';
import { canTransition, nextLifecycleStatus, type LifecycleSnapshot } from './subscription-state-machine';

const d = (iso: string): Date => new Date(iso);

function snapshot(partial: Partial<LifecycleSnapshot> & Pick<LifecycleSnapshot, 'status'>): LifecycleSnapshot {
  return {
    currentPeriodEnd: d('2026-11-01T00:00:00Z'),
    trialEndsAt: null,
    statusChangedAt: d('2026-10-01T00:00:00Z'),
    cancelAtPeriodEnd: false,
    ...partial,
  };
}

describe('transitions autorisées (docs/05 A6)', () => {
  const allowed: ReadonlyArray<readonly [SubscriptionStatus, SubscriptionStatus]> = [
    ['trial', 'active'],
    ['trial', 'expired'],
    ['active', 'active'],
    ['active', 'past_due'],
    ['active', 'cancelled'],
    ['past_due', 'active'],
    ['past_due', 'grace'],
    ['grace', 'active'],
    ['grace', 'suspended'],
    ['suspended', 'active'],
    ['suspended', 'expired'],
    ['cancelled', 'active'],
    ['cancelled', 'expired'],
    ['expired', 'active'],
  ];

  it.each(allowed)('%s → %s est autorisée', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it('refuse toutes les autres transitions', () => {
    const allowedKeys = new Set(allowed.map(([a, b]) => `${a}>${b}`));
    for (const from of SUBSCRIPTION_STATUSES) {
      for (const to of SUBSCRIPTION_STATUSES) {
        if (!allowedKeys.has(`${from}>${to}`)) expect(canTransition(from, to), `${from} → ${to}`).toBe(false);
      }
    }
  });
});

describe('nextLifecycleStatus (horloge simulée)', () => {
  it('essai : expire à l’échéance exacte, pas avant', () => {
    const s = snapshot({ status: 'trial', trialEndsAt: d('2026-11-03T00:00:00Z') });
    expect(nextLifecycleStatus(s, d('2026-11-02T23:59:59Z'))).toBeNull();
    expect(nextLifecycleStatus(s, d('2026-11-03T00:00:00Z'))).toBe('expired');
  });

  it('actif : passe en past_due à la fin de période', () => {
    const s = snapshot({ status: 'active' });
    expect(nextLifecycleStatus(s, d('2026-10-31T23:59:59Z'))).toBeNull();
    expect(nextLifecycleStatus(s, d('2026-11-01T00:00:00Z'))).toBe('past_due');
  });

  it('actif avec résiliation programmée : passe en cancelled à la fin de période', () => {
    const s = snapshot({ status: 'active', cancelAtPeriodEnd: true });
    expect(nextLifecycleStatus(s, d('2026-11-01T00:00:00Z'))).toBe('cancelled');
  });

  it('past_due → grace à J+7, grace → suspended à J+15, suspended → expired à J+75 de l’échéance', () => {
    expect(nextLifecycleStatus(snapshot({ status: 'past_due' }), d('2026-11-07T23:59:59Z'))).toBeNull();
    expect(nextLifecycleStatus(snapshot({ status: 'past_due' }), d('2026-11-08T00:00:00Z'))).toBe('grace');
    expect(nextLifecycleStatus(snapshot({ status: 'grace' }), d('2026-11-15T23:59:59Z'))).toBeNull();
    expect(nextLifecycleStatus(snapshot({ status: 'grace' }), d('2026-11-16T00:00:00Z'))).toBe('suspended');
    expect(nextLifecycleStatus(snapshot({ status: 'suspended' }), d('2027-01-14T23:59:59Z'))).toBeNull();
    expect(nextLifecycleStatus(snapshot({ status: 'suspended' }), d('2027-01-15T00:00:00Z'))).toBe('expired');
  });

  it('cancelled : expire après 90 jours de rétention depuis la résiliation', () => {
    const s = snapshot({ status: 'cancelled', statusChangedAt: d('2026-11-01T00:00:00Z') });
    expect(nextLifecycleStatus(s, d('2026-01-01T00:00:00Z'))).toBeNull();
    expect(nextLifecycleStatus(s, d('2026-11-01T00:00:00Z'))).toBeNull();
    expect(nextLifecycleStatus(s, d('2027-01-30T00:00:00Z'))).toBe('expired');
  });

  it('expired est terminal pour le cycle automatique', () => {
    expect(nextLifecycleStatus(snapshot({ status: 'expired' }), d('2030-01-01T00:00:00Z'))).toBeNull();
  });
});
