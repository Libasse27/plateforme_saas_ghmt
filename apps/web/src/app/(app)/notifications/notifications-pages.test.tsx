import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';

const state = vi.hoisted(() => ({ routes: new Map<string, unknown>(), calls: [] as { path: string; query: unknown }[] }));

vi.mock('next/navigation', async () => (await import('@/actions/test-kit')).navigationMock());
vi.mock('next/cache', async () => (await import('@/actions/test-kit')).cacheMock());
vi.mock('next/headers', async () => (await import('@/actions/test-kit')).headersMock());
vi.mock('@/server/me', () => ({
  requireMe: async () => ({ user: { id: 'u' }, tenant: { timezone: 'Africa/Dakar' }, permissions: [], modules: [] }),
}));
vi.mock('@/server/api', () => ({
  actionApi: vi.fn(),
  pageApi: async (path: string, options?: { query?: unknown }) => {
    state.calls.push({ path, query: options?.query });
    const route = state.routes.get(path);
    if (route instanceof Error) throw route;
    if (route === undefined) throw new ApiError({ status: 404, code: 'not_found' });
    const envelope = route as { data?: unknown; meta?: unknown };
    return { data: 'data' in envelope ? envelope.data : route, meta: envelope.meta ?? {}, status: 200 };
  },
}));

import NotificationsPage from './page';
import PreferencesPage from './preferences/page';

const message = { id: 'm1', typeCode: 'quota.sms_threshold', title: 'Quota SMS', body: 'Seuil atteint', link: '/abonnement', createdAt: '2026-10-05T10:00:00.000Z', readAt: null };

beforeEach(() => {
  state.routes.clear();
  state.calls.length = 0;
});

describe('boîte de notifications', () => {
  it('liste, filtre non lues et curseur transmis à l\'API', async () => {
    state.routes.set('/notifications/inbox', { data: [message], meta: { pagination: { hasMore: true, nextCursor: 'MTIz' } } });
    render(await NotificationsPage({ searchParams: Promise.resolve({ filtre: 'non-lues', apres: 'MDEy' }) }));
    expect(state.calls[0]?.query).toEqual({ unreadOnly: 'true', cursor: 'MDEy', limit: 20 });
    expect(screen.getByText('Quota SMS')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Non lues' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Page suivante' })).toHaveAttribute('href', '/notifications?filtre=non-lues&apres=MTIz');
    expect(screen.getByRole('link', { name: 'Retour au début' })).toHaveAttribute('href', '/notifications?filtre=non-lues');
    expect(screen.getByRole('button', { name: 'Tout marquer comme lu' })).toBeInTheDocument();
  });
  it('paramètres invalides ignorés, état vide', async () => {
    state.routes.set('/notifications/inbox', []);
    render(await NotificationsPage({ searchParams: Promise.resolve({ filtre: 'x', apres: '../y' }) }));
    expect(state.calls[0]?.query).toEqual({ unreadOnly: undefined, cursor: undefined, limit: 20 });
    expect(screen.getByText('Aucune notification pour le moment.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Toutes' })).toHaveAttribute('aria-current', 'page');
  });
  it('erreur de l\'API', async () => {
    state.routes.set('/notifications/inbox', new ApiError({ status: 503, code: 'x' }));
    render(await NotificationsPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});

describe('préférences', () => {
  it('affiche les interrupteurs, le verrouillé est désactivé', async () => {
    state.routes.set('/notifications/preferences', {
      items: [
        { category: 'administrative', channel: 'inapp', enabled: true, locked: true, note: null },
        { category: 'administrative', channel: 'email', enabled: false, locked: false, note: 'Les relances de facturation restent envoyées aux administrateurs.' },
      ],
    });
    render(await PreferencesPage());
    expect(screen.getByLabelText(/Dans l'application/)).toBeDisabled();
    expect(screen.getByLabelText(/E-mail/)).not.toBeChecked();
  });
  it('erreur de l\'API', async () => {
    state.routes.set('/notifications/preferences', new ApiError({ status: 500, code: 'x' }));
    render(await PreferencesPage());
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
