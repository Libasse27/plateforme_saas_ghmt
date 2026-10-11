import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';

const state = vi.hoisted(() => ({ calls: [] as { path: string; method: string | undefined; body: unknown }[], result: null as unknown }));

vi.mock('@/server/api', () => ({
  publicRequest: async (path: string, options?: { method?: string; body?: unknown }) => {
    state.calls.push({ path, method: options?.method, body: options?.body });
    if (state.result instanceof Error) throw state.result;
    return { data: state.result, meta: {}, status: 200 };
  },
}));
vi.mock('@/actions/password-reset', () => ({ forgotPasswordAction: vi.fn(), resetPasswordAction: vi.fn() }));
vi.mock('@/actions/signup-verification', () => ({ resendSignupVerificationAction: vi.fn(), verifySignupAction: vi.fn() }));
vi.mock('@/actions/auth', () => ({ loginAction: vi.fn(), signupAction: vi.fn() }));

import ConnexionPage from './connexion/page';
import ConfirmerPage from './inscription/confirmer/[token]/page';
import VerifierPage from './inscription/verifier/page';
import ForgotPage from './mot-de-passe-oublie/page';
import ResetPage from './reinitialiser/[token]/page';

const TOKEN = '0190a3b2-7c11-7a55-9e0f-3a1b2c3d4e5f.abcdefghijklmnopqrstuvwxyz0123456789_-ABCDEF';
const params = (token: string) => Promise.resolve({ token });
const search = (values: Record<string, string | string[] | undefined> = {}) => Promise.resolve(values);

beforeEach(() => {
  state.calls.length = 0;
  state.result = null;
});

function allHrefs(): string[] {
  return screen.queryAllByRole('link').map((link) => link.getAttribute('href') ?? '');
}

describe('/mot-de-passe-oublie', () => {
  it('affiche le formulaire, avec le code établissement pré-rempli depuis l\'URL', async () => {
    render(await ForgotPage({ searchParams: search({ etablissement: 'clinique-a' }) }));
    expect(screen.getByRole('heading', { level: 1, name: 'Mot de passe oublié' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Code établissement/)).toHaveValue('clinique-a');
  });

  it('ne reprend pas un code établissement invalide de l\'URL', async () => {
    render(await ForgotPage({ searchParams: search({ etablissement: '"><script>' }) }));
    expect(screen.getByLabelText(/Code établissement/)).toHaveValue('');
  });
});

describe('/reinitialiser/[token]', () => {
  it('affiche l\'aperçu (e-mail masqué) et le formulaire ; le jeton part dans le corps de la requête d\'aperçu', async () => {
    state.result = { tenantSlug: 'clinique-a', emailMasked: 'a***@clinique.sn', mfaRequired: true };
    render(await ResetPage({ params: params(TOKEN) }));
    expect(state.calls).toEqual([{ path: '/auth/password/reset/preview', method: 'POST', body: { token: TOKEN } }]);
    expect(screen.getByText('a***@clinique.sn')).toBeInTheDocument();
    expect(screen.getByLabelText(/Code de vérification/)).toBeInTheDocument();
    expect(screen.getByLabelText('Nouveau mot de passe', { exact: false })).toBeInTheDocument();
  });

  it('aucun lien généré ne contient le jeton', async () => {
    state.result = { tenantSlug: 'clinique-a', emailMasked: 'a***@clinique.sn', mfaRequired: false };
    render(await ResetPage({ params: params(TOKEN) }));
    for (const href of allHrefs()) expect(href).not.toContain('abcdefghijklmnop');
  });

  it('410 : lien invalide ou expiré, avec lien vers une nouvelle demande, sans formulaire', async () => {
    state.result = new ApiError({ status: 410, code: 'reset_token_invalid' });
    render(await ResetPage({ params: params(TOKEN) }));
    expect(screen.getByRole('alert')).toHaveTextContent('invalide ou a expiré');
    expect(screen.getByRole('link', { name: 'Demander un nouveau lien' })).toHaveAttribute('href', '/mot-de-passe-oublie');
    expect(screen.queryByLabelText('Nouveau mot de passe', { exact: false })).not.toBeInTheDocument();
  });

  it('jeton mal formé : même écran d\'invalidité, sans appel à l\'API', async () => {
    render(await ResetPage({ params: params('../../etc/passwd') }));
    expect(state.calls).toHaveLength(0);
    expect(screen.getByRole('alert')).toHaveTextContent('invalide ou a expiré');
  });

  it('aperçu inexploitable : écran d\'erreur, jamais de formulaire', async () => {
    state.result = {};
    render(await ResetPage({ params: params(TOKEN) }));
    expect(screen.queryByLabelText('Nouveau mot de passe', { exact: false })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('panne réseau de l\'aperçu : message de service, pas de plantage', async () => {
    state.result = ApiError.network();
    render(await ResetPage({ params: params(TOKEN) }));
    expect(screen.getByRole('alert')).toHaveTextContent('Service injoignable');
  });
});

describe('/inscription/verifier', () => {
  it('invite à consulter la boîte e-mail et propose le renvoi, code établissement pré-rempli', async () => {
    render(await VerifierPage({ searchParams: search({ etablissement: 'clinique-neuve' }) }));
    expect(screen.getByRole('heading', { level: 1, name: 'Vérifiez votre boîte e-mail' })).toBeInTheDocument();
    expect(screen.getByText(/Cliquez sur le lien reçu/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Code établissement/)).toHaveValue('clinique-neuve');
    expect(screen.getByRole('button', { name: 'Renvoyer l\'e-mail de confirmation' })).toBeInTheDocument();
  });

  it('sans paramètre : formulaire vide', async () => {
    render(await VerifierPage({ searchParams: search() }));
    expect(screen.getByLabelText(/Code établissement/)).toHaveValue('');
  });
});

describe('/inscription/confirmer/[token]', () => {
  it('n\'appelle PAS l\'API au chargement : un bouton de confirmation est présenté', async () => {
    render(await ConfirmerPage({ params: params(TOKEN) }));
    expect(state.calls).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Confirmer mon adresse' })).toBeInTheDocument();
  });

  it('jeton mal formé : lien invalide, sans bouton', async () => {
    render(await ConfirmerPage({ params: params('abc') }));
    expect(screen.getByRole('alert')).toHaveTextContent('invalide, déjà utilisé ou expiré');
    expect(screen.queryByRole('button', { name: 'Confirmer mon adresse' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Recevoir un nouveau lien' })).toHaveAttribute('href', '/inscription/verifier');
  });

  it('aucun lien généré ne contient le jeton', async () => {
    render(await ConfirmerPage({ params: params(TOKEN) }));
    for (const href of allHrefs()) expect(href).not.toContain('abcdefghijklmnop');
  });
});

describe('/connexion : bandeaux', () => {
  it('?reinitialise=1 : mot de passe modifié', async () => {
    render(await ConnexionPage({ searchParams: search({ reinitialise: '1', etablissement: 'clinique-a' }) }));
    expect(screen.getByRole('status')).toHaveTextContent('Mot de passe modifié');
    expect(screen.getByLabelText(/Code établissement/)).toHaveValue('clinique-a');
  });

  it('?confirme=1 : adresse confirmée, établissement activé', async () => {
    render(await ConnexionPage({ searchParams: search({ confirme: '1' }) }));
    expect(screen.getByRole('status')).toHaveTextContent('Adresse e-mail confirmée');
  });

  it('sans paramètre : aucun bandeau, lien « Mot de passe oublié ? » présent', async () => {
    render(await ConnexionPage({ searchParams: search() }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Mot de passe oublié ?' })).toBeInTheDocument();
  });
});
