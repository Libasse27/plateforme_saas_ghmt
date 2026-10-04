import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const signupAction = vi.fn();
vi.mock('@/actions/auth', () => ({ signupAction: (...args: unknown[]) => signupAction(...args) }));

import { SignupWizard } from './SignupWizard';

beforeEach(() => {
  signupAction.mockReset();
});

async function fillEstablishment(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/Code établissement/), 'clinique-sante');
  await user.type(screen.getByLabelText(/Raison sociale/), 'Clinique Santé SARL');
  await user.selectOptions(screen.getByLabelText(/Type d'établissement/), 'clinic');
}

describe('SignupWizard', () => {
  it('commence à l\'étape 1 et liste les types d\'établissement en français', () => {
    render(<SignupWizard />);
    expect(screen.getByText('1. Établissement')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('option', { name: 'Clinique' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Hôpital de niveau 2/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Créer l'établissement/ })).not.toBeInTheDocument();
  });

  it('bloque le passage à l\'étape suivante tant que l\'étape est invalide', async () => {
    const user = userEvent.setup();
    render(<SignupWizard />);
    await user.click(screen.getByRole('button', { name: 'Suivant' }));
    expect(screen.getByText('1. Établissement')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByLabelText(/Code établissement/)).toHaveAttribute('aria-invalid', 'true');
  });

  it('pré-remplit devise et fuseau selon le pays', async () => {
    const user = userEvent.setup();
    render(<SignupWizard />);
    await user.selectOptions(screen.getByLabelText(/Pays/), 'CM');
    expect(screen.getByLabelText(/Devise/)).toHaveValue('XAF');
    expect(screen.getByLabelText(/Fuseau horaire/)).toHaveValue('Africa/Douala');
  });

  it('parcourt les trois étapes et n\'affiche le bouton final qu\'à la dernière', async () => {
    const user = userEvent.setup();
    render(<SignupWizard />);
    await fillEstablishment(user);
    await user.click(screen.getByRole('button', { name: 'Suivant' }));
    expect(screen.getByText('2. Site principal')).toHaveAttribute('aria-current', 'step');

    await user.type(screen.getByLabelText(/Nom du site/), 'Site central');
    await user.click(screen.getByRole('button', { name: 'Suivant' }));
    expect(screen.getByText('3. Administrateur')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('button', { name: /Créer l'établissement/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Précédent' }));
    expect(screen.getByText('2. Site principal')).toHaveAttribute('aria-current', 'step');
  });

  it('affiche les erreurs du serveur et ramène à l\'étape concernée', async () => {
    signupAction.mockResolvedValue({
      ok: false,
      message: 'Certains champs sont invalides. Corrigez-les puis réessayez.',
      fieldErrors: { 'establishment.slug': 'Ce code établissement est déjà utilisé.' },
      values: { 'establishment.slug': 'clinique-sante' },
    });
    const user = userEvent.setup();
    render(<SignupWizard />);
    await fillEstablishment(user);
    await user.click(screen.getByRole('button', { name: 'Suivant' }));
    await user.type(screen.getByLabelText(/Nom du site/), 'Site central');
    await user.click(screen.getByRole('button', { name: 'Suivant' }));
    await user.type(screen.getByLabelText(/Nom complet/), 'Aminata Diallo');
    await user.type(screen.getByLabelText(/Adresse e-mail/), 'a@clinique.sn');
    await user.type(screen.getByLabelText(/^Mot de passe/), 'un-mot-de-passe-long');
    await user.type(screen.getByLabelText(/Confirmer/), 'un-mot-de-passe-long');
    await user.click(screen.getByRole('button', { name: /Créer l'établissement/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Certains champs sont invalides');
    expect(screen.getByText('1. Établissement')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByLabelText(/Code établissement/)).toHaveAccessibleDescription(/déjà utilisé/);
    const formData = signupAction.mock.calls[0]?.[1] as FormData;
    expect(formData.get('admin.email')).toBe('a@clinique.sn');
    expect(formData.get('establishment.establishmentType')).toBe('clinic');
  });
});
