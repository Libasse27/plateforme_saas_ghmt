import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const platformLogin = vi.fn();
vi.mock('@/actions/platform-auth', () => ({ platformLoginAction: (...args: unknown[]) => platformLogin(...args) }));
vi.mock('@/actions/auth', () => ({ mfaVerifyAction: vi.fn() }));
vi.mock('@/actions/mfa-setup', () => ({ startTotpSetupAction: vi.fn(), activateTotpAction: vi.fn() }));

import { MfaVerifyForm } from './MfaVerifyForm';
import { PlatformLoginForm } from './PlatformLoginForm';
import { TotpEnrolment } from './TotpEnrolment';

beforeEach(() => {
  platformLogin.mockReset();
});

describe('PlatformLoginForm', () => {
  it('n\'a pas de champ « code établissement » et expose des champs étiquetés', () => {
    render(<PlatformLoginForm next="/plateforme" />);
    expect(screen.queryByLabelText(/Code établissement/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Adresse e-mail/)).toHaveAttribute('autocomplete', 'username');
    expect(screen.getByLabelText(/Mot de passe/)).toHaveAttribute('type', 'password');
  });

  it('soumet e-mail, mot de passe et chemin de retour à l\'action plateforme', async () => {
    platformLogin.mockResolvedValue({});
    const user = userEvent.setup();
    render(<PlatformLoginForm next="/plateforme/plans" />);
    await user.type(screen.getByLabelText(/Adresse e-mail/), 'root@ghmt.test');
    await user.type(screen.getByLabelText(/Mot de passe/), 'secret-123');
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));
    await waitFor(() => expect(platformLogin).toHaveBeenCalled());
    const data = platformLogin.mock.calls[0]?.[1] as FormData;
    expect(data.get('email')).toBe('root@ghmt.test');
    expect(data.get('next')).toBe('/plateforme/plans');
  });

  it('affiche l\'erreur de connexion et conserve l\'e-mail saisi', async () => {
    platformLogin.mockResolvedValue({ ok: false, message: 'E-mail ou mot de passe invalide.', values: { email: 'root@ghmt.test' } });
    const user = userEvent.setup();
    render(<PlatformLoginForm next="/plateforme" />);
    await user.type(screen.getByLabelText(/Adresse e-mail/), 'root@ghmt.test');
    await user.type(screen.getByLabelText(/Mot de passe/), 'x');
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('E-mail ou mot de passe invalide.');
    expect(screen.getByLabelText(/Adresse e-mail/)).toHaveValue('root@ghmt.test');
  });
});

describe('composants MFA paramétrables par realm', () => {
  it('MfaVerifyForm utilise l\'action fournie', async () => {
    const action = vi.fn().mockResolvedValue({});
    const user = userEvent.setup();
    render(<MfaVerifyForm next="/plateforme" action={action} />);
    await user.type(screen.getByLabelText(/Code de vérification/), '123456');
    await user.click(screen.getByRole('button', { name: 'Valider' }));
    await waitFor(() => expect(action).toHaveBeenCalled());
    expect((action.mock.calls[0]?.[1] as FormData).get('code')).toBe('123456');
  });

  it('TotpEnrolment utilise les actions et le lien de fin fournis', async () => {
    const startSetup = vi.fn().mockResolvedValue({ ok: true, extra: { qrDataUrl: 'data:image/svg+xml;charset=utf-8,x', secret: 'SECRET' } });
    const activate = vi.fn().mockResolvedValue({ ok: true, message: 'Activée.', extra: { backupCodes: ['AAAAA11111'] } });
    const user = userEvent.setup();
    render(<TotpEnrolment startSetup={startSetup} activate={activate} continueHref="/plateforme" />);
    await user.click(screen.getByRole('button', { name: 'Générer le QR code' }));
    await user.type(await screen.findByLabelText(/Code à 6 chiffres/), '123456');
    await user.click(screen.getByRole('button', { name: /Activer/ }));
    expect(await screen.findByRole('link', { name: /continuer/ })).toHaveAttribute('href', '/plateforme');
    expect(startSetup).toHaveBeenCalled();
  });
});
