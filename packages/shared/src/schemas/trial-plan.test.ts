import { describe, expect, it } from 'vitest';
import { ESTABLISHMENT_TYPES } from './index';
import { TRIAL_DAYS, trialPlanCodeFor } from './subscriptions';

describe('trialPlanCodeFor (docs/05 A3, plafonné à Standard)', () => {
  it.each([
    ['private_practice', 'basic'],
    ['pharmacy', 'basic'],
    ['laboratory', 'basic'],
    ['other', 'basic'],
    ['diagnostic_center', 'standard'],
    ['health_center', 'standard'],
    ['medicalized_center', 'standard'],
    ['specialized_center', 'standard'],
    ['clinic', 'standard'],
    ['hospital_n1', 'standard'],
    ['hospital_n2', 'standard'],
    ['hospital_n3', 'standard'],
  ] as const)('%s ⇒ %s', (type, plan) => {
    expect(trialPlanCodeFor(type)).toBe(plan);
  });

  it('couvre tous les types d’établissement et ne dépasse jamais Standard', () => {
    for (const type of ESTABLISHMENT_TYPES) expect(['basic', 'standard']).toContain(trialPlanCodeFor(type));
  });

  it('prévoit un essai de 30 jours', () => {
    expect(TRIAL_DAYS).toBe(30);
  });
});
