import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const start = vi.fn();
const activate = vi.fn();
vi.mock('@/actions/mfa-setup', () => ({
  startTotpSetupAction: (...args: unknown[]) => start(...args),
  activateTotpAction: (...args: unknown[]) => activate(...args),
}));

import { TotpEnrolment } from './TotpEnrolment';

beforeEach(() => {
  start.mockReset();
  activate.mockReset();
});

describe('TotpEnrolment', () => {
  it('propose d\'abord de générer le QR code', () => {
    render(<TotpEnrolment />);
    expect(screen.getByRole('button', { name: 'Générer le QR code' })).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('affiche le QR code, la clé manuelle puis les codes de secours une seule fois', async () => {
    start.mockResolvedValue({ ok: true, extra: { qrDataUrl: 'data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E', secret: 'JBSWY3DPEHPK3PXP' } });
    activate.mockResolvedValue({ ok: true, message: 'Authentification à deux facteurs activée.', extra: { backupCodes: ['ABCDE23456', 'FGHJK78923'] } });
    const user = userEvent.setup();
    render(<TotpEnrolment />);

    await user.click(screen.getByRole('button', { name: 'Générer le QR code' }));
    expect(await screen.findByRole('img', { name: /QR code/ })).toHaveAttribute('src', expect.stringContaining('data:image/svg+xml'));
    expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument();

    await user.type(screen.getByLabelText(/Code à 6 chiffres/), '123456');
    await user.click(screen.getByRole('button', { name: /Activer/ }));

    const list = await screen.findByRole('list', { name: 'Codes de secours' });
    expect(list).toHaveTextContent('ABCDE23456');
    expect(list).toHaveTextContent('FGHJK78923');
    expect(screen.getByText(/ne seront plus affichés/)).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('garde les codes de secours affichés quand la page serveur se rafraîchit avec le facteur désormais actif', async () => {
    start.mockResolvedValue({ ok: true, extra: { qrDataUrl: 'data:image/svg+xml;charset=utf-8,x', secret: 'S' } });
    activate.mockResolvedValue({ ok: true, message: 'Authentification à deux facteurs activée.', extra: { backupCodes: ['ABCDE23456'] } });
    const user = userEvent.setup();
    const { rerender } = render(<TotpEnrolment alreadyActive={false} />);
    await user.click(screen.getByRole('button', { name: 'Générer le QR code' }));
    await user.type(await screen.findByLabelText(/Code à 6 chiffres/), '123456');
    await user.click(screen.getByRole('button', { name: /Activer/ }));
    await screen.findByRole('list', { name: 'Codes de secours' });

    // Le cookie de session réécrit par l'action rafraîchit la page serveur, qui voit maintenant le facteur actif.
    rerender(<TotpEnrolment alreadyActive />);
    expect(screen.getByRole('list', { name: 'Codes de secours' })).toHaveTextContent('ABCDE23456');
    expect(screen.queryByText(/déjà active/)).not.toBeInTheDocument();
  });

  it('facteur déjà actif à l\'ouverture : message et retour, sans nouvel enrôlement', () => {
    render(<TotpEnrolment alreadyActive />);
    expect(screen.getByText(/déjà active/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Retour au tableau de bord' })).toHaveAttribute('href', '/');
    expect(screen.queryByRole('button', { name: 'Générer le QR code' })).not.toBeInTheDocument();
  });

  it('affiche l\'erreur de code invalide sans quitter l\'étape de saisie', async () => {
    start.mockResolvedValue({ ok: true, extra: { qrDataUrl: 'data:image/svg+xml;charset=utf-8,x', secret: 'S' } });
    activate.mockResolvedValue({ ok: false, message: 'Code invalide ou expiré.', fieldErrors: { code: 'Code invalide.' } });
    const user = userEvent.setup();
    render(<TotpEnrolment />);
    await user.click(screen.getByRole('button', { name: 'Générer le QR code' }));
    await user.type(await screen.findByLabelText(/Code à 6 chiffres/), '000000');
    await user.click(screen.getByRole('button', { name: /Activer/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Code invalide ou expiré.');
    expect(screen.getByLabelText(/Code à 6 chiffres/)).toHaveAttribute('aria-invalid', 'true');
  });
});
