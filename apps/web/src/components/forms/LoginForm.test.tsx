import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loginAction = vi.fn();
vi.mock('@/actions/auth', () => ({ loginAction: (...args: unknown[]) => loginAction(...args) }));

import { LoginForm } from './LoginForm';

beforeEach(() => {
  loginAction.mockReset();
});

describe('LoginForm', () => {
  it('expose des champs étiquetés avec les bons attributs d\'accessibilité', () => {
    render(<LoginForm next="/patients" defaultTenant="clinique-a" />);
    expect(screen.getByLabelText(/Code établissement/)).toHaveValue('clinique-a');
    expect(screen.getByLabelText(/Adresse e-mail/)).toHaveAttribute('autocomplete', 'username');
    expect(screen.getByLabelText(/Mot de passe/)).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Se connecter' })).toBeEnabled();
  });

  it('soumet les valeurs saisies (dont le chemin de retour) à l\'action serveur', async () => {
    loginAction.mockResolvedValue({});
    const user = userEvent.setup();
    render(<LoginForm next="/patients" />);
    await user.type(screen.getByLabelText(/Code établissement/), 'clinique-a');
    await user.type(screen.getByLabelText(/Adresse e-mail/), 'a@x.sn');
    await user.type(screen.getByLabelText(/Mot de passe/), 'secret-123');
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));

    await waitFor(() => expect(loginAction).toHaveBeenCalledTimes(1));
    const formData = loginAction.mock.calls[0]?.[1] as FormData;
    expect(formData.get('tenantSlug')).toBe('clinique-a');
    expect(formData.get('email')).toBe('a@x.sn');
    expect(formData.get('password')).toBe('secret-123');
    expect(formData.get('next')).toBe('/patients');
  });

  it('affiche le message global et les erreurs par champ renvoyés par le serveur', async () => {
    loginAction.mockResolvedValue({
      ok: false,
      message: 'Identifiants invalides.',
      fieldErrors: { email: 'Adresse e-mail invalide.' },
      values: { email: 'mauvais', tenantSlug: 'clinique-a' },
    });
    const user = userEvent.setup();
    render(<LoginForm next="/" />);
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Identifiants invalides.');
    const email = screen.getByLabelText(/Adresse e-mail/);
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(email).toHaveAccessibleDescription('Adresse e-mail invalide.');
    expect(email).toHaveValue('mauvais');
  });

  it('propose le lien « Mot de passe oublié ? » vers la page publique', () => {
    render(<LoginForm next="/" />);
    expect(screen.getByRole('link', { name: 'Mot de passe oublié ?' })).toHaveAttribute('href', '/mot-de-passe-oublie');
  });

  it('email_verification_required : propose le renvoi de l\'e-mail de confirmation pour cet établissement', async () => {
    loginAction.mockResolvedValue({
      ok: false,
      message: 'Confirmez l\'adresse e-mail de l\'administrateur pour activer l\'établissement.',
      extra: { verificationTenant: 'clinique-a' },
    });
    const user = userEvent.setup();
    render(<LoginForm next="/" />);
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Confirmez l\'adresse e-mail');
    expect(screen.getByRole('link', { name: /Renvoyer l'e-mail de confirmation/ })).toHaveAttribute('href', '/inscription/verifier?etablissement=clinique-a');
  });

  it('n\'affiche pas le lien de renvoi pour les autres erreurs', async () => {
    loginAction.mockResolvedValue({ ok: false, message: 'Identifiants invalides.' });
    const user = userEvent.setup();
    render(<LoginForm next="/" />);
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));
    await screen.findByRole('alert');
    expect(screen.queryByRole('link', { name: /Renvoyer/ })).not.toBeInTheDocument();
  });
});

describe('LoginForm : délai progressif (compte à rebours)', () => {
  const delayed = (seconds: number) => ({
    ok: false,
    message: `Trop de tentatives pour ce compte. Réessayez dans ${String(seconds)} secondes.`,
    extra: { retryAfterSeconds: seconds },
  });

  async function submitWithFakeTimers(seconds: number) {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    loginAction.mockResolvedValue(delayed(seconds));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<LoginForm next="/" />);
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));
    await screen.findByRole('alert');
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('désactive le bouton et décompte les secondes jusqu\'à la réactivation', async () => {
    await submitWithFakeTimers(3);
    const button = screen.getByRole('button', { name: /Réessayez dans 3 s/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-disabled', 'true');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByRole('button', { name: /Réessayez dans 2 s/ })).toBeDisabled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByRole('button', { name: 'Se connecter' })).toBeEnabled();
  });

  it('conserve les champs saisis pendant l\'attente', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    loginAction.mockResolvedValue({ ...delayed(30), values: { tenantSlug: 'clinique-a', email: 'awa@x.sn' } });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<LoginForm next="/" />);
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));
    await screen.findByRole('alert');
    expect(screen.getByLabelText(/Adresse e-mail/)).toHaveValue('awa@x.sn');
  });

  it('une nouvelle réponse avec délai relance le compte à rebours', async () => {
    await submitWithFakeTimers(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(screen.getByRole('button', { name: 'Se connecter' })).toBeEnabled();
    loginAction.mockResolvedValue(delayed(60));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));
    expect(await screen.findByRole('button', { name: /Réessayez dans 60 s/ })).toBeDisabled();
  });

  it('ignore un délai non numérique ou négatif', async () => {
    loginAction.mockResolvedValue({ ok: false, message: 'Erreur', extra: { retryAfterSeconds: -5 } });
    const user = userEvent.setup();
    render(<LoginForm next="/" />);
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Se connecter' })).toBeEnabled();
  });
});
