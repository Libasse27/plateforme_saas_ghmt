import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
});
