import { render, screen, within } from '@testing-library/react';
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
    const envelope = route as { data: unknown; meta?: unknown };
    return { data: 'data' in envelope ? envelope.data : route, meta: envelope.meta ?? {}, status: 200 };
  },
}));

import AdministrationPage from './page';
import AuditPage from './journal/page';
import OrganisationPage from './organisation/page';
import PractitionersPage from './praticiens/page';
import RolesPage from './roles/page';
import UserPage from './utilisateurs/[id]/page';
import UsersPage from './utilisateurs/page';
import NewRolePage from './roles/nouveau/page';

const SITE = '0190c1a0-1111-7000-8000-000000000001';
const USER = '0190c1a0-2222-7000-8000-000000000002';

function setMe(permissions: string[], modules: string[] = []) {
  state.me = {
    user: { id: 'u-me', fullName: 'Admin', email: 'a@b.sn', mustChangePassword: false },
    tenant: { id: 't1', slug: 'c', name: 'Clinique', timezone: 'Africa/Dakar', countryCode: 'SN', baseCurrency: 'XOF' },
    permissions, modules, mfa: { enrolled: true, verified: true, required: true },
  } as Me;
}
const search = (values: Record<string, string> = {}) => Promise.resolve(values);

beforeEach(() => {
  state.routes.clear();
  state.calls.length = 0;
  setMe([]);
});

const DENIED = /Vous n'avez pas accès/;

describe('accès refusé sans permission', () => {
  it.each([
    ['tableau de bord', () => AdministrationPage({ searchParams: search() })],
    ['organisation', () => OrganisationPage()],
    ['utilisateurs', () => UsersPage({ searchParams: search() })],
    ['fiche utilisateur', () => UserPage({ params: Promise.resolve({ id: USER }) })],
    ['rôles', () => RolesPage()],
    ['nouveau rôle', () => NewRolePage()],
    ['praticiens', () => PractitionersPage({ searchParams: search() })],
    ['journal', () => AuditPage({ searchParams: search() })],
  ])('%s', async (_name, page) => {
    render(await page());
    expect(screen.getByText(DENIED)).toBeInTheDocument();
    expect(state.calls).toHaveLength(0);
  });
  it('praticiens : la permission seule ne suffit pas sans le module appointments', async () => {
    setMe(['appointments:agenda:read'], []);
    render(await PractitionersPage({ searchParams: search() }));
    expect(screen.getByText(DENIED)).toBeInTheDocument();
  });
});

describe('tableau de bord', () => {
  it('affiche les cartes et le sélecteur de site (plusieurs sites)', async () => {
    setMe(['reports:dashboard:read', 'org:site:read']);
    state.routes.set('/dashboards/establishment', { date: '2026-10-05', patients: { total: 12, registeredToday: 1 }, appointments: null, revenue: null, cashSessions: null });
    state.routes.set('/org/sites', [{ id: SITE, code: 'A', name: 'Site A', city: '' }, { id: 'b', code: 'B', name: 'Site B', city: '' }]);
    render(await AdministrationPage({ searchParams: search({ site: SITE }) }));
    expect(screen.getByRole('heading', { name: 'Patients' })).toBeInTheDocument();
    expect(screen.getByLabelText('Site')).toHaveValue(SITE);
    expect(state.calls.find((c) => c.path === '/dashboards/establishment')?.query).toEqual({ siteId: SITE });
  });
  it('ignore un site non uuid et affiche l\'erreur de l\'API', async () => {
    setMe(['reports:dashboard:read']);
    state.routes.set('/dashboards/establishment', new ApiError({ status: 503, code: 'x' }));
    render(await AdministrationPage({ searchParams: search({ site: '../x' }) }));
    expect(screen.getByRole('alert')).toHaveTextContent('problème');
    expect(state.calls[0]?.query).toBeUndefined();
  });
});

describe('organisation', () => {
  it('sites et services avec actions selon les droits', async () => {
    setMe(['org:site:read', 'org:site:create', 'org:service:read']);
    state.routes.set('/org/sites', [{ id: SITE, code: 'A', name: 'Site A', city: 'Dakar', isMain: true }]);
    state.routes.set('/org/departments', [{ id: 'd1', siteId: SITE, code: 'MG', name: 'Médecine', kind: 'clinical' }]);
    render(await OrganisationPage());
    expect(screen.getByRole('button', { name: 'Créer le site' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Modifier le site/ })).not.toBeInTheDocument();
    expect(screen.getByText('Médecine')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Créer le service' })).not.toBeInTheDocument();
  });
  it('erreur de chargement des sites', async () => {
    setMe(['org:site:read']);
    state.routes.set('/org/sites', new ApiError({ status: 403, code: 'x' }));
    render(await OrganisationPage());
    expect(screen.getByRole('alert')).toHaveTextContent('autorisation');
  });
});

const userRow = (i: number) => ({ id: `0190c1a0-0000-7000-8000-00000000000${i}`, email: `u${i}@b.sn`, fullName: `Personnel ${i}`, status: 'active', locale: 'fr', lastLoginAt: null });

describe('utilisateurs', () => {
  it('liste, filtres valides seulement, page suivante sans donnée patient', async () => {
    setMe(['iam:user:read', 'iam:user:create']);
    state.routes.set('/iam/users', { data: [userRow(1), userRow(2)], meta: { pagination: { hasMore: true, nextCursor: 'MTIz' } } });
    render(await UsersPage({ searchParams: search({ statut: 'locked', q: 'Awa', apres: 'MDEy', patient: 'Jean DUPONT' }) }));
    expect(screen.getByText('Personnel 1')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Inviter un utilisateur' })).toHaveAttribute('href', '/administration/utilisateurs/inviter');
    expect(state.calls[0]?.query).toEqual({ status: 'locked', q: 'Awa', cursor: 'MDEy', limit: 25 });
    const next = screen.getByRole('link', { name: 'Page suivante' }).getAttribute('href') as string;
    expect(next).toBe('/administration/utilisateurs?statut=locked&q=Awa&apres=MTIz');
    expect(next).not.toContain('Jean');
  });
  it('statut et curseur invalides ignorés, bouton d\'invitation masqué', async () => {
    setMe(['iam:user:read']);
    state.routes.set('/iam/users', []);
    render(await UsersPage({ searchParams: search({ statut: 'hacker', apres: '../x' }) }));
    expect(state.calls[0]?.query).toEqual({ status: undefined, q: undefined, cursor: undefined, limit: 25 });
    expect(screen.queryByRole('link', { name: 'Inviter un utilisateur' })).not.toBeInTheDocument();
    expect(screen.getByText('Aucun utilisateur ne correspond à ces critères.')).toBeInTheDocument();
  });
  it('erreur de l\'API', async () => {
    setMe(['iam:user:read']);
    state.routes.set('/iam/users', new ApiError({ status: 500, code: 'x' }));
    render(await UsersPage({ searchParams: search() }));
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});

describe('fiche utilisateur', () => {
  const detail = { ...userRow(1), id: USER, status: 'invited', assignments: [{ id: 'a1', roleId: 'r1', roleCode: 'doctor', roleName: 'Médecin', scopeType: 'site', scopeId: SITE, validFrom: '2026-10-01T00:00:00.000Z', validUntil: null }] };
  it('boutons et sections selon les permissions', async () => {
    setMe(['iam:user:read', 'iam:user:update', 'iam:user:create', 'iam:assignment:read', 'iam:assignment:create', 'iam:assignment:delete', 'iam:role:read', 'org:site:read']);
    state.routes.set(`/iam/users/${USER}`, detail);
    state.routes.set('/iam/roles', [{ id: 'r1', code: 'doctor', name: 'Médecin', isSystem: true }]);
    state.routes.set('/org/sites', [{ id: SITE, code: 'A', name: 'Site A' }]);
    render(await UserPage({ params: Promise.resolve({ id: USER }) }));
    expect(screen.getByRole('button', { name: 'Renvoyer l\'invitation' })).toBeInTheDocument();
    expect(screen.getByText('Site : Site A')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ajouter l\'affectation' })).toBeInTheDocument();
    expect(screen.getByText('Retirer')).toBeInTheDocument();
  });
  it('lecture seule : aucune action ni formulaire', async () => {
    setMe(['iam:user:read']);
    state.routes.set(`/iam/users/${USER}`, detail);
    render(await UserPage({ params: Promise.resolve({ id: USER }) }));
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText('Affectations (rôle et portée)')).not.toBeInTheDocument();
  });
  it('identifiant non uuid ou utilisateur inconnu : page introuvable', async () => {
    setMe(['iam:user:read']);
    await expect(UserPage({ params: Promise.resolve({ id: '../x' }) })).rejects.toThrow('NOT_FOUND');
    await expect(UserPage({ params: Promise.resolve({ id: USER }) })).rejects.toThrow('NOT_FOUND');
  });
  it('affectations vides : message explicite', async () => {
    setMe(['iam:user:read', 'iam:assignment:read']);
    state.routes.set(`/iam/users/${USER}`, { ...detail, assignments: [] });
    render(await UserPage({ params: Promise.resolve({ id: USER }) }));
    expect(screen.getByText(/Aucune affectation/)).toBeInTheDocument();
  });
});

describe('rôles', () => {
  it('sépare rôles personnalisés et système, création conditionnée', async () => {
    setMe(['iam:role:read', 'iam:role:create']);
    state.routes.set('/iam/roles', [
      { id: 'r1', code: 'doctor', name: 'Médecin', isSystem: true, permissionCount: 10 },
      { id: 'r2', code: 'chef', name: 'Infirmier chef', isSystem: false, permissionCount: 1, description: 'Coordination' },
    ]);
    render(await RolesPage());
    const custom = screen.getByRole('region', { name: 'Rôles personnalisés' });
    expect(within(custom).getByText('Infirmier chef')).toBeInTheDocument();
    expect(within(custom).getByText('1 permission')).toBeInTheDocument();
    const system = screen.getByRole('region', { name: 'Rôles système' });
    expect(within(system).getByText('Système')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Nouveau rôle' })).toBeInTheDocument();
  });
  it('listes vides', async () => {
    setMe(['iam:role:read']);
    state.routes.set('/iam/roles', []);
    render(await RolesPage());
    expect(screen.getByText('Aucun rôle personnalisé.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Nouveau rôle' })).not.toBeInTheDocument();
  });
});

describe('praticiens', () => {
  it('liste avec lien de création selon agenda:update', async () => {
    setMe(['appointments:agenda:read', 'appointments:agenda:update'], ['appointments']);
    state.routes.set('/practitioners', { data: [{ id: 'p1', fullName: 'Dr Awa', specialty: 'Pédiatrie', defaultConsultMinutes: 30, isBookable: true }], meta: { pagination: { hasMore: true, nextCursor: 'abc' } } });
    render(await PractitionersPage({ searchParams: search({ apres: 'MDEy' }) }));
    expect(screen.getByRole('link', { name: 'Dr Awa' })).toHaveAttribute('href', '/administration/praticiens/p1');
    expect(screen.getByRole('link', { name: 'Nouveau praticien' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Page suivante' })).toHaveAttribute('href', '/administration/praticiens?apres=abc');
    expect(screen.getByRole('link', { name: 'Retour au début' })).toBeInTheDocument();
  });
  it('vide', async () => {
    setMe(['appointments:agenda:read'], ['appointments']);
    state.routes.set('/practitioners', []);
    render(await PractitionersPage({ searchParams: search() }));
    expect(screen.getByText('Aucun praticien.')).toBeInTheDocument();
  });
});

describe('journal d\'audit', () => {
  const log = { id: 'a1', seq: '5', occurredAt: '2026-10-05T10:00:00.000Z', actor: { type: 'user', userId: USER, fullName: 'Awa' }, action: 'auth.login', resourceType: null, outcome: 'success', changes: null };
  it('convertit les filtres, pagine par curseur, jamais de terme de recherche patient dans les liens', async () => {
    setMe(['audit:log:read', 'audit:log:export']);
    state.routes.set('/audit-logs', { data: [log], meta: { pagination: { hasMore: true, nextCursor: 'MTA' } } });
    render(await AuditPage({ searchParams: search({ du: '2026-10-01', action: 'auth.*', resultat: 'denied', patient: 'Jean DUPONT', q: 'Jean', apres: 'MDk' }) }));
    expect(state.calls[0]?.query).toEqual({ from: '2026-10-01T00:00:00.000Z', action: 'auth.*', outcome: 'denied', limit: 50, cursor: 'MDk' });
    const next = screen.getByRole('link', { name: 'Page suivante' }).getAttribute('href') as string;
    expect(next).toBe('/administration/journal?du=2026-10-01&action=auth.*&resultat=denied&apres=MTA');
    for (const link of screen.getAllByRole('link')) expect(link.getAttribute('href') ?? '').not.toMatch(/Jean|DUPONT/i);
    expect(screen.getByRole('button', { name: 'Exporter en CSV' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Vérifier l\'intégrité' })).toBeInTheDocument();
  });
  it('sans permission d\'export : pas de bouton ; état vide ; échec d\'export annoncé', async () => {
    setMe(['audit:log:read']);
    state.routes.set('/audit-logs', []);
    render(await AuditPage({ searchParams: search({ export: 'trop-volumineux' }) }));
    expect(screen.queryByRole('button', { name: 'Exporter en CSV' })).not.toBeInTheDocument();
    expect(screen.getByText('Aucun événement pour ces filtres.')).toBeInTheDocument();
    expect(screen.getByText(/10 000 lignes/)).toBeInTheDocument();
  });
  it('clé d\'échec inconnue ignorée ; erreur de l\'API (période trop longue)', async () => {
    setMe(['audit:log:read']);
    state.routes.set('/audit-logs', new ApiError({ status: 422, code: 'range_too_large' }));
    render(await AuditPage({ searchParams: search({ export: '<script>' }) }));
    expect(screen.getByRole('alert')).toHaveTextContent('période');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });
});
