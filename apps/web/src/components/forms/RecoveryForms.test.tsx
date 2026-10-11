import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const forgot = vi.fn();
const reset = vi.fn();
const resend = vi.fn();
const verify = vi.fn();
vi.mock('@/actions/password-reset', () => ({
  forgotPasswordAction: (...args: unknown[]) => forgot(...args),
  resetPasswordAction: (...args: unknown[]) => reset(...args),
}));
vi.mock('@/actions/signup-verification', () => ({
  resendSignupVerificationAction: (...args: unknown[]) => resend(...args),
  verifySignupAction: (...args: unknown[]) => verify(...args),
}));

import { ForgotPasswordForm } from './ForgotPasswordForm';
import { ResetPasswordForm } from './ResetPasswordForm';
import { ConfirmSignupForm, ResendVerificationForm } from './SignupVerificationForms';

const TOKEN = '0190a3b2-7c11-7a55-9e0f-3a1b2c3d4e5f.abcdefghijklmnopqrstuvwxyz0123456789_-ABCDEF';

beforeEach(() => {
  forgot.mockReset();
  reset.mockReset();
  resend.mockReset();
  verify.mockReset();
});

describe('ForgotPasswordForm', () => {
  it('expose des champs étiquetés et pré-remplit le code établissement', () => {
    render(<ForgotPasswordForm defaultTenant="clinique-a" />);
    expect(screen.getByLabelText(/Code établissement/)).toHaveValue('clinique-a');
    expect(screen.getByLabelText(/Adresse e-mail/)).toHaveAttribute('type', 'email');
    expect(screen.getByRole('button', { name: 'Envoyer le lien' })).toBeEnabled();
    expect(screen.getByRole('link', { name: 'Retour à la connexion' })).toHaveAttribute('href', '/connexion');
  });

  it('soumet les valeurs, puis affiche le message unique à la place du formulaire', async () => {
    forgot.mockResolvedValue({ ok: true, message: 'Si un compte correspond à ces informations, un e-mail vient d\'être envoyé.' });
    const user = userEvent.setup();
    render(<ForgotPasswordForm />);
    await user.type(screen.getByLabelText(/Code établissement/), 'clinique-a');
    await user.type(screen.getByLabelText(/Adresse e-mail/), 'awa@clinique.sn');
    await user.click(screen.getByRole('button', { name: 'Envoyer le lien' }));

    const data = forgot.mock.calls[0]?.[1] as FormData;
    expect(data.get('tenantSlug')).toBe('clinique-a');
    expect(data.get('email')).toBe('awa@clinique.sn');
    expect(await screen.findByRole('status')).toHaveTextContent('Si un compte correspond à ces informations');
    expect(screen.queryByLabelText(/Adresse e-mail/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Retour à la connexion' })).toBeInTheDocument();
  });

  it('affiche les erreurs de champ et garde le formulaire', async () => {
    forgot.mockResolvedValue({ ok: false, message: 'Certains champs sont invalides.', fieldErrors: { email: 'Adresse e-mail invalide.' }, values: { email: 'x', tenantSlug: 'clinique-a' } });
    const user = userEvent.setup();
    render(<ForgotPasswordForm />);
    await user.click(screen.getByRole('button', { name: 'Envoyer le lien' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('invalides');
    expect(screen.getByLabelText(/Adresse e-mail/)).toHaveAccessibleDescription('Adresse e-mail invalide.');
  });
});

describe('ResetPasswordForm', () => {
  const props = { token: TOKEN, tenantSlug: 'clinique-a', emailMasked: 'a***@clinique.sn', mfaRequired: false } as const;

  it('affiche l\'aperçu du compte et les champs de mot de passe, sans champ de code', () => {
    render(<ResetPasswordForm {...props} />);
    expect(screen.getByText('a***@clinique.sn')).toBeInTheDocument();
    expect(screen.getByText('clinique-a')).toBeInTheDocument();
    expect(screen.getByLabelText('Nouveau mot de passe', { exact: false })).toHaveAttribute('autocomplete', 'new-password');
    expect(screen.getByLabelText(/Confirmer le mot de passe/)).toHaveAttribute('type', 'password');
    expect(screen.queryByLabelText(/Code de vérification/)).not.toBeInTheDocument();
  });

  it('affiche le champ « code de vérification » quand le second facteur est actif', () => {
    render(<ResetPasswordForm {...props} mfaRequired />);
    const field = screen.getByLabelText(/Code de vérification/);
    expect(field).toHaveAttribute('autocomplete', 'one-time-code');
    expect(field).toBeRequired();
  });

  it('soumet le jeton et le code établissement en champs cachés, sans les afficher', async () => {
    reset.mockResolvedValue({});
    const user = userEvent.setup();
    render(<ResetPasswordForm {...props} mfaRequired />);
    await user.type(screen.getByLabelText('Nouveau mot de passe', { exact: false }), 'un-nouveau-mot-de-passe');
    await user.type(screen.getByLabelText(/Confirmer le mot de passe/), 'un-nouveau-mot-de-passe');
    await user.type(screen.getByLabelText(/Code de vérification/), '123456');
    await user.click(screen.getByRole('button', { name: 'Modifier le mot de passe' }));

    const data = reset.mock.calls[0]?.[1] as FormData;
    expect(data.get('token')).toBe(TOKEN);
    expect(data.get('tenantSlug')).toBe('clinique-a');
    expect(data.get('newPassword')).toBe('un-nouveau-mot-de-passe');
    expect(data.get('mfaCode')).toBe('123456');
    expect(screen.queryByText(TOKEN)).not.toBeInTheDocument();
  });

  it('un code requis par le serveur fait apparaître le champ avec son erreur', async () => {
    reset.mockResolvedValue({ ok: false, message: 'Saisissez le code de vérification de votre application (ou un code de secours).', fieldErrors: { mfaCode: 'Saisissez le code.' }, extra: { mfaRequired: true } });
    const user = userEvent.setup();
    render(<ResetPasswordForm {...props} />);
    await user.click(screen.getByRole('button', { name: 'Modifier le mot de passe' }));
    const field = await screen.findByLabelText(/Code de vérification/);
    expect(field).toHaveAccessibleDescription(expect.stringContaining('Saisissez le code.'));
    expect(field).toHaveAttribute('aria-invalid', 'true');
  });

  it('lien invalide (410) : message, lien vers une nouvelle demande, plus de formulaire', async () => {
    reset.mockResolvedValue({ ok: false, message: 'Ce lien de réinitialisation est invalide ou a expiré. Demandez-en un nouveau.', extra: { linkInvalid: true } });
    const user = userEvent.setup();
    render(<ResetPasswordForm {...props} />);
    await user.click(screen.getByRole('button', { name: 'Modifier le mot de passe' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('invalide ou a expiré');
    expect(screen.getByRole('link', { name: 'Demander un nouveau lien' })).toHaveAttribute('href', '/mot-de-passe-oublie');
    expect(screen.queryByLabelText('Nouveau mot de passe', { exact: false })).not.toBeInTheDocument();
  });

  it('erreur de confirmation affichée sur le champ concerné', async () => {
    reset.mockResolvedValue({ ok: false, message: 'Certains champs sont invalides.', fieldErrors: { confirmPassword: 'Les mots de passe ne correspondent pas.' } });
    const user = userEvent.setup();
    render(<ResetPasswordForm {...props} />);
    await user.click(screen.getByRole('button', { name: 'Modifier le mot de passe' }));
    expect(await screen.findByLabelText(/Confirmer le mot de passe/)).toHaveAccessibleDescription('Les mots de passe ne correspondent pas.');
  });
});

describe('ResendVerificationForm', () => {
  it('pré-remplit le code établissement et soumet à l\'action de renvoi', async () => {
    resend.mockResolvedValue({ ok: true, message: 'Si un compte en attente correspond, un nouvel e-mail est envoyé.' });
    const user = userEvent.setup();
    render(<ResendVerificationForm defaultTenant="clinique-neuve" />);
    expect(screen.getByLabelText(/Code établissement/)).toHaveValue('clinique-neuve');
    await user.type(screen.getByLabelText(/Adresse e-mail/), 'awa@clinique.sn');
    await user.click(screen.getByRole('button', { name: 'Renvoyer l\'e-mail de confirmation' }));
    const data = resend.mock.calls[0]?.[1] as FormData;
    expect(data.get('tenantSlug')).toBe('clinique-neuve');
    expect(data.get('email')).toBe('awa@clinique.sn');
    expect(await screen.findByRole('status')).toHaveTextContent('nouvel e-mail');
  });

  it('affiche l\'erreur de limitation', async () => {
    resend.mockResolvedValue({ ok: false, message: 'Trop de tentatives, réessayez dans quelques instants.' });
    const user = userEvent.setup();
    render(<ResendVerificationForm />);
    await user.click(screen.getByRole('button', { name: 'Renvoyer l\'e-mail de confirmation' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Trop de tentatives');
  });
});

describe('ConfirmSignupForm', () => {
  it('n\'appelle rien au chargement : la confirmation exige un clic', () => {
    render(<ConfirmSignupForm token={TOKEN} />);
    expect(verify).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Confirmer mon adresse' })).toBeEnabled();
  });

  it('envoie le jeton au clic', async () => {
    verify.mockResolvedValue({});
    const user = userEvent.setup();
    render(<ConfirmSignupForm token={TOKEN} />);
    await user.click(screen.getByRole('button', { name: 'Confirmer mon adresse' }));
    expect(verify).toHaveBeenCalledTimes(1);
    expect((verify.mock.calls[0]?.[1] as FormData).get('token')).toBe(TOKEN);
  });

  it('410 : message d\'erreur et lien vers le renvoi', async () => {
    verify.mockResolvedValue({ ok: false, message: 'Ce lien de confirmation est invalide, déjà utilisé ou expiré.', extra: { linkInvalid: true } });
    const user = userEvent.setup();
    render(<ConfirmSignupForm token={TOKEN} />);
    await user.click(screen.getByRole('button', { name: 'Confirmer mon adresse' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('déjà utilisé ou expiré');
    expect(screen.getByRole('link', { name: 'Recevoir un nouveau lien' })).toHaveAttribute('href', '/inscription/verifier');
  });
});
