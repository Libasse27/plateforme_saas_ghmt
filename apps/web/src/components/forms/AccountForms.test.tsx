import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const changePasswordAction = vi.fn();
const acceptInvitationAction = vi.fn();
vi.mock('@/actions/password', () => ({ changePasswordAction: (...args: unknown[]) => changePasswordAction(...args) }));
vi.mock('@/actions/invitation', () => ({ acceptInvitationAction: (...args: unknown[]) => acceptInvitationAction(...args) }));

import { InvitationForm } from './InvitationForm';
import { PasswordChangeForm } from './PasswordChangeForm';

beforeEach(() => {
  changePasswordAction.mockReset();
  acceptInvitationAction.mockReset();
});

describe('PasswordChangeForm', () => {
  it('affiche les erreurs par champ', async () => {
    changePasswordAction.mockResolvedValue({ ok: false, message: 'Certains champs sont invalides.', fieldErrors: { newPassword: 'Trop court.', confirmPassword: 'Différent.' } });
    const user = userEvent.setup();
    render(<PasswordChangeForm />);
    await user.click(screen.getByRole('button', { name: 'Changer le mot de passe' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Nouveau mot de passe/)).toHaveAccessibleDescription(/Trop court/);
    expect(screen.getByLabelText(/^Confirmer/)).toHaveAccessibleDescription('Différent.');
  });
});

describe('InvitationForm', () => {
  it('transmet le jeton en champ caché et affiche l\'erreur', async () => {
    acceptInvitationAction.mockResolvedValue({ ok: false, message: 'Cette invitation est expirée.' });
    const user = userEvent.setup();
    render(<InvitationForm token="t.k" />);
    await user.type(screen.getByLabelText(/^Mot de passe/), 'un-mot-de-passe');
    await user.click(screen.getByRole('button', { name: 'Définir mon mot de passe' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('expirée');
    expect((acceptInvitationAction.mock.calls[0]?.[1] as FormData).get('token')).toBe('t.k');
  });
});
