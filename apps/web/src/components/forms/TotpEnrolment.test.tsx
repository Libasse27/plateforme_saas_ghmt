import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const start = vi.fn();
const activate = vi.fn();
const sendCode = vi.fn();
vi.mock('@/actions/mfa-setup', () => ({
  startTotpSetupAction: (...args: unknown[]) => start(...args),
  activateTotpAction: (...args: unknown[]) => activate(...args),
  sendMfaEmailCodeAction: (...args: unknown[]) => sendCode(...args),
}));

import { TotpEnrolment } from './TotpEnrolment';

beforeEach(() => {
  start.mockReset();
  activate.mockReset();
  sendCode.mockReset();
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

describe('TotpEnrolment : étape « code par e-mail » hors réseau de confiance (docs/11 D7)', () => {
  const QR = { ok: true, extra: { qrDataUrl: 'data:image/svg+xml;charset=utf-8,x', secret: 'S3CRET' } };
  const EMAIL_STEP = { ok: false, extra: { emailCodeRequired: true } };

  async function reachEmailStep(user: ReturnType<typeof userEvent.setup>) {
    start.mockResolvedValueOnce(EMAIL_STEP);
    render(<TotpEnrolment />);
    await user.click(screen.getByRole('button', { name: 'Générer le QR code' }));
    return screen.findByRole('button', { name: 'Recevoir un code par e-mail' });
  }

  it('sur 403 mfa_email_code_required, propose de recevoir un code par e-mail, sans alerte d\'erreur', async () => {
    const user = userEvent.setup();
    expect(await reachEmailStep(user)).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(/en dehors du réseau de votre établissement/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Code reçu par e-mail/)).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('envoie le code, affiche l\'adresse masquée puis le champ de saisie', async () => {
    sendCode.mockResolvedValue({ ok: true, message: 'Un code à 6 chiffres vient d\'être envoyé à a***@clinique.sn.', extra: { emailMasked: 'a***@clinique.sn' } });
    const user = userEvent.setup();
    await reachEmailStep(user);
    await user.click(screen.getByRole('button', { name: 'Recevoir un code par e-mail' }));
    expect(await screen.findByRole('status')).toHaveTextContent('a***@clinique.sn');
    const field = await screen.findByLabelText(/Code reçu par e-mail/);
    expect(field).toHaveAttribute('inputmode', 'numeric');
    expect(field).toHaveAttribute('autocomplete', 'one-time-code');
    expect(screen.getByRole('button', { name: 'Renvoyer le code' })).toBeEnabled();
  });

  it('un bon code mène au QR code puis à l\'activation, le code étant transmis à l\'action de démarrage', async () => {
    sendCode.mockResolvedValue({ ok: true, message: 'Code envoyé.', extra: {} });
    start.mockResolvedValueOnce(EMAIL_STEP).mockResolvedValueOnce(QR);
    const user = userEvent.setup();
    render(<TotpEnrolment />);
    await user.click(screen.getByRole('button', { name: 'Générer le QR code' }));
    await user.click(await screen.findByRole('button', { name: 'Recevoir un code par e-mail' }));
    await user.type(await screen.findByLabelText(/Code reçu par e-mail/), '482913');
    await user.click(screen.getByRole('button', { name: 'Valider le code' }));

    expect(await screen.findByRole('img', { name: /QR code/ })).toBeInTheDocument();
    expect(start).toHaveBeenLastCalledWith('482913');
    expect(screen.getByLabelText(/Code à 6 chiffres/)).toBeInTheDocument();
  });

  it('un code invalide reste sur l\'étape de saisie, avec l\'erreur sur le champ', async () => {
    sendCode.mockResolvedValue({ ok: true, message: 'Code envoyé.', extra: {} });
    start
      .mockResolvedValueOnce(EMAIL_STEP)
      .mockResolvedValueOnce({ ok: false, fieldErrors: { emailCode: 'Le code reçu par e-mail est invalide ou expiré.' }, extra: { emailCodeRequired: true } });
    const user = userEvent.setup();
    render(<TotpEnrolment />);
    await user.click(screen.getByRole('button', { name: 'Générer le QR code' }));
    await user.click(await screen.findByRole('button', { name: 'Recevoir un code par e-mail' }));
    await user.type(await screen.findByLabelText(/Code reçu par e-mail/), '000000');
    await user.click(screen.getByRole('button', { name: 'Valider le code' }));

    const field = await screen.findByLabelText(/Code reçu par e-mail/);
    await waitFor(() => expect(field).toHaveAttribute('aria-invalid', 'true'));
    expect(field).toHaveAccessibleDescription(expect.stringContaining('invalide ou expiré'));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('réseau devenu de confiance (422 email_code_not_required) : message et retour à la génération directe', async () => {
    sendCode.mockResolvedValue({ ok: false, extra: { emailCodeNotRequired: true } });
    const user = userEvent.setup();
    await reachEmailStep(user);
    await user.click(screen.getByRole('button', { name: 'Recevoir un code par e-mail' }));
    expect(await screen.findByRole('button', { name: 'Générer le QR code' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('réseau de confiance');
  });

  it('erreur d\'envoi (429) : message d\'erreur, le bouton reste disponible', async () => {
    sendCode.mockResolvedValue({ ok: false, message: 'Trop de tentatives, réessayez dans quelques instants.' });
    const user = userEvent.setup();
    await reachEmailStep(user);
    await user.click(screen.getByRole('button', { name: 'Recevoir un code par e-mail' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Trop de tentatives');
    expect(screen.getByRole('button', { name: 'Recevoir un code par e-mail' })).toBeEnabled();
  });

  it('les actions injectées (console plateforme) sont appelées sans étape e-mail', async () => {
    const startSetup = vi.fn().mockResolvedValue(QR);
    const user = userEvent.setup();
    render(<TotpEnrolment startSetup={startSetup} activate={activate} />);
    await user.click(screen.getByRole('button', { name: 'Générer le QR code' }));
    expect(await screen.findByRole('img', { name: /QR code/ })).toBeInTheDocument();
    expect(sendCode).not.toHaveBeenCalled();
  });
});
