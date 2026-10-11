import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import type { Me } from '@/lib/auth/me';

const state = vi.hoisted(() => ({ me: null as unknown, routes: new Map<string, unknown>(), calls: [] as { path: string; query: unknown }[] }));

vi.mock('next/navigation', async () => (await import('@/actions/test-kit')).navigationMock());
vi.mock('next/cache', async () => (await import('@/actions/test-kit')).cacheMock());
vi.mock('next/headers', async () => (await import('@/actions/test-kit')).headersMock());
vi.mock('@/server/me', () => ({ requireMe: async () => state.me }));
vi.mock('@/server/api', () => ({
  actionApi: vi.fn(),
  pageApi: async (path: string, options?: { query?: unknown }) => {
    state.calls.push({ path, query: options?.query });
    const route = state.routes.get(path);
    if (route instanceof Error) throw route;
    if (route === undefined) throw new ApiError({ status: 404, code: 'not_found' });
    return { data: route, meta: {}, status: 200 };
  },
}));

import SecurityPage from './page';

const ME_ID = '0190c1a0-aaaa-7000-8000-000000000001';
const OTHER = '0190c1a0-bbbb-7000-8000-000000000002';
const SITE = '0190c1a0-cccc-7000-8000-000000000003';

function setMe(permissions: string[]) {
  state.me = {
    user: { id: ME_ID, fullName: 'Admin', email: 'a@b.sn', mustChangePassword: false },
    tenant: { id: 't1', slug: 'c', name: 'Clinique', timezone: 'Africa/Dakar', countryCode: 'SN', baseCurrency: 'XOF' },
    permissions,
    modules: [],
    mfa: { enrolled: true, verified: true, required: true },
  } as Me;
}

const policy = (overrides: Record<string, unknown> = {}) => ({
  clinicalMfa: 'off_network',
  trustedNetworks: [{ id: '0190c1a0-dddd-7000-8000-000000000004', cidr: '203.0.113.0/24', label: 'Siège', siteId: SITE, createdAt: '2026-10-05T08:00:00.000Z', createdBy: { id: ME_ID, fullName: 'Admin' } }],
  requestIp: '198.51.100.7',
  requestIpTrusted: false,
  owner: { id: ME_ID, fullName: 'Admin' },
  updatedAt: null,
  ...overrides,
});

beforeEach(() => {
  state.routes.clear();
  state.calls.length = 0;
  setMe([]);
});

describe('/administration/securite', () => {
  it('sans iam:policy:read : accès refusé, aucun appel d\'API', async () => {
    setMe(['iam:user:read']);
    render(await SecurityPage());
    expect(screen.getByText(/Vous n'avez pas accès/)).toBeInTheDocument();
    expect(state.calls).toHaveLength(0);
  });

  it('affiche la politique, les réseaux, l\'adresse actuelle et l\'administrateur principal', async () => {
    setMe(['iam:policy:read', 'iam:policy:update', 'org:site:read']);
    state.routes.set('/iam/security/policy', policy());
    state.routes.set('/org/sites', [{ id: SITE, code: 'A', name: 'Dakar Plateau', city: 'Dakar' }]);
    render(await SecurityPage());
    expect(screen.getByRole('heading', { level: 1, name: 'Sécurité' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Hors du réseau de l'établissement seulement/ })).toBeChecked();
    expect(screen.getByText('203.0.113.0/24')).toBeInTheDocument();
    expect(screen.getByText('203.0.113.0/24').closest('tr')).toHaveTextContent('Dakar Plateau');
    expect(screen.getByText(/Votre adresse actuelle : 198\.51\.100\.7/)).toHaveTextContent('réseau de confiance : non');
    expect(screen.getByText(/Administrateur principal : Admin/)).toBeInTheDocument();
  });

  it('sans iam:policy:update : tout est en lecture seule', async () => {
    setMe(['iam:policy:read']);
    state.routes.set('/iam/security/policy', policy());
    render(await SecurityPage());
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText('Transférer le titre')).not.toBeInTheDocument();
  });

  it('le principal voit le formulaire de transfert avec les autres utilisateurs actifs seulement', async () => {
    setMe(['iam:policy:read', 'iam:policy:update', 'iam:user:read']);
    state.routes.set('/iam/security/policy', policy());
    state.routes.set('/iam/users', [
      { id: ME_ID, email: 'a@b.sn', fullName: 'Admin', status: 'active' },
      { id: OTHER, email: 'm@b.sn', fullName: 'Moussa Ndiaye', status: 'active' },
    ]);
    render(await SecurityPage());
    expect(screen.getByText('Transférer le titre')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Moussa Ndiaye (m@b.sn)' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Admin \(a@b.sn\)/ })).not.toBeInTheDocument();
    expect(state.calls.find((c) => c.path === '/iam/users')?.query).toEqual({ status: 'active', limit: 100 });
  });

  it('un administrateur non principal ne voit pas le transfert, et le principal est nommé', async () => {
    setMe(['iam:policy:read', 'iam:policy:update', 'iam:user:read']);
    state.routes.set('/iam/security/policy', policy({ owner: { id: OTHER, fullName: 'Fatou Sow' } }));
    render(await SecurityPage());
    expect(screen.queryByText('Transférer le titre')).not.toBeInTheDocument();
    expect(screen.getByText(/Administrateur principal : Fatou Sow/)).toBeInTheDocument();
    expect(state.calls.some((c) => c.path === '/iam/users')).toBe(false);
  });

  it('principal sans droit de lecture des utilisateurs : transfert indisponible, avec explication', async () => {
    setMe(['iam:policy:read', 'iam:policy:update']);
    state.routes.set('/iam/security/policy', policy());
    render(await SecurityPage());
    expect(screen.queryByText('Transférer le titre')).not.toBeInTheDocument();
    expect(screen.getByText(/Aucun autre utilisateur actif/)).toBeInTheDocument();
  });

  it('aucun principal connu : le dit sans planter', async () => {
    setMe(['iam:policy:read']);
    state.routes.set('/iam/security/policy', policy({ owner: null }));
    render(await SecurityPage());
    expect(screen.getByText(/Administrateur principal : non désigné/)).toBeInTheDocument();
  });

  it('erreur de l\'API : message français', async () => {
    setMe(['iam:policy:read']);
    state.routes.set('/iam/security/policy', new ApiError({ status: 500, code: 'x' }));
    render(await SecurityPage());
    expect(screen.getByRole('alert')).toHaveTextContent('problème');
  });
});
