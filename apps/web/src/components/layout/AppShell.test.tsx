import { render, screen, within } from '@testing-library/react';
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

const ADMIN_ME = { ...ME, permissions: ['iam:user:read', 'audit:log:read', 'reports:dashboard:read'], modules: [] } as unknown as Me;

describe('navigation Administration', () => {
  it('regroupe les entrées d\'administration sous un intitulé, avec le tableau de bord en correspondance exacte', () => {
    render(<AppShell me={ADMIN_ME}>x</AppShell>);
    const group = screen.getByRole('group', { name: 'Administration' });
    const links = within(group).getAllByRole('link').map((link) => link.getAttribute('href'));
    expect(links).toEqual(['/administration', '/administration/utilisateurs', '/administration/journal']);
    expect(within(screen.getByRole('navigation', { name: 'Navigation principale' })).getByRole('link', { name: 'Notifications' })).toHaveAttribute('href', '/notifications');
  });
  it('sans permission d\'administration : aucun groupe', () => {
    render(<AppShell me={ME}>x</AppShell>);
    expect(screen.queryByRole('group', { name: 'Administration' })).not.toBeInTheDocument();
  });
  it('le tableau de bord n\'est pas actif sur une sous-page d\'administration', async () => {
    const navigation = await import('next/navigation');
    vi.spyOn(navigation, 'usePathname').mockReturnValue('/administration/utilisateurs');
    render(<AppShell me={ADMIN_ME}>x</AppShell>);
    expect(screen.getByRole('link', { name: 'Utilisateurs' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Tableau de bord établissement' })).not.toHaveAttribute('aria-current');
  });
});

describe('cloche de notifications', () => {
  it('affiche le compteur initial dans l\'en-tête', () => {
    render(<AppShell me={ME} unread={{ count: 5, capped: false }}>x</AppShell>);
    expect(screen.getByRole('link', { name: 'Notifications, 5 non lues' })).toHaveAttribute('href', '/notifications');
  });
  it('sans compteur (échec du chargement) : cloche sans nombre', () => {
    render(<AppShell me={ME}>x</AppShell>);
    expect(screen.getAllByRole('link', { name: 'Notifications' })).toHaveLength(2);
  });
});
