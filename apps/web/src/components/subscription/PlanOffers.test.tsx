import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { toPublicPlan } from '@/lib/domain/subscription';

vi.mock('@/actions/subscription', () => ({ changePlanAction: vi.fn() }));

import { PlanOffers } from './PlanOffers';

const plan = (code: string, selectable: boolean) =>
  toPublicPlan({ id: code, code, name: code.toUpperCase(), tier: 'basic', priceMonthly: '25000.00', priceYearly: '250000.00', currency: 'XOF', selectable, entitlements: {} });

describe('PlanOffers en essai', () => {
  it('désactive les offres non sélectionnables avec la mention dédiée', () => {
    render(<PlanOffers plans={[plan('basic', true), plan('premium', false)]} current={null} canUpdate />);
    expect(screen.getByText('Disponible après la période d\'essai')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choisir BASIC' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Choisir PREMIUM' })).not.toBeInTheDocument();
  });
});
