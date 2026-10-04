import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const changeStatus = vi.fn();
vi.mock('@/actions/appointments', () => ({ changeAppointmentStatusAction: (...args: unknown[]) => changeStatus(...args) }));

import { allowedStatusActions } from '@/lib/domain/appointments';
import { StatusActions } from './StatusActions';

beforeEach(() => {
  changeStatus.mockReset();
});

describe('StatusActions', () => {
  it('ne rend rien pour un rendez-vous terminé', () => {
    const { container } = render(<StatusActions appointmentId="a1" actions={allowedStatusActions('completed')} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('propose Confirmer, Arrivé et Annuler pour un rendez-vous planifié', () => {
    render(<StatusActions appointmentId="a1" actions={allowedStatusActions('scheduled')} />);
    expect(screen.getByRole('button', { name: 'Confirmer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Arrivé' })).toBeInTheDocument();
    expect(screen.getByText('Annuler')).toBeInTheDocument();
  });

  it('envoie le statut cible et l\'identifiant lors de la confirmation', async () => {
    changeStatus.mockResolvedValue({ ok: true, message: 'Statut mis à jour.' });
    const user = userEvent.setup();
    render(<StatusActions appointmentId="a1" actions={allowedStatusActions('scheduled')} />);
    await user.click(screen.getByRole('button', { name: 'Confirmer' }));

    await waitFor(() => expect(changeStatus).toHaveBeenCalled());
    const formData = changeStatus.mock.calls[0]?.[1] as FormData;
    expect(formData.get('appointmentId')).toBe('a1');
    expect(formData.get('status')).toBe('confirmed');
    expect(await screen.findByRole('status')).toHaveTextContent('Statut mis à jour.');
  });

  it('exige un motif pour annuler et l\'envoie à l\'action', async () => {
    changeStatus.mockResolvedValue({ ok: false, message: 'Cette opération est en conflit avec des données existantes.' });
    const user = userEvent.setup();
    render(<StatusActions appointmentId="a1" actions={allowedStatusActions('scheduled')} />);
    await user.click(screen.getByText('Annuler'));
    await user.type(screen.getByLabelText(/Motif d'annulation/), 'Patient indisponible');
    await user.click(screen.getByRole('button', { name: /Confirmer l'annulation/ }));

    await waitFor(() => expect(changeStatus).toHaveBeenCalled());
    const formData = changeStatus.mock.calls[0]?.[1] as FormData;
    expect(formData.get('status')).toBe('cancelled');
    expect(formData.get('cancelReason')).toBe('Patient indisponible');
    expect(await screen.findByRole('alert')).toHaveTextContent('en conflit');
  });
});
