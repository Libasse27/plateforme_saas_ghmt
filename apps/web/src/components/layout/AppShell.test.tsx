import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Me } from '@/lib/auth/me';

vi.mock('@/actions/auth', () => ({ logoutAction: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => '/' }));

import { AppShell } from './AppShell';

const ME = { user: { id: 'u', email: 'a@b.c', firstName: 'A', lastName: 'B' }, tenant: { name: 'Clinique' }, permissions: [], modules: [] } as unknown as Me;

describe('bandeau d\'abonnement', () => {
  it('affiche le message à tout le personnel sans lien vers /abonnement', () => {
    render(<AppShell me={ME} banner={{ tone: 'warning', message: 'Abonnement en retard de paiement' }}>x</AppShell>);
    expect(screen.getByTestId('subscription-banner')).toHaveTextContent('Abonnement en retard de paiement');
    expect(screen.queryByRole('link', { name: /Voir l'abonnement/ })).not.toBeInTheDocument();
  });
  it('les administrateurs gardent leur lien', () => {
    render(<AppShell me={ME} banner={{ tone: 'info', message: 'Période d\'essai — J-3' }} canManageSubscription>x</AppShell>);
    expect(screen.getByRole('link', { name: /Voir l'abonnement/ })).toHaveAttribute('href', '/abonnement');
  });
});
