import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const searchPatientsAction = vi.fn();
vi.mock('@/actions/patients', () => ({ searchPatientsAction: (...args: unknown[]) => searchPatientsAction(...args) }));
vi.mock('@/actions/appointments', () => ({ createAppointmentAction: vi.fn() }));

import { AppointmentBooking } from './AppointmentBooking';

const props = { practitioners: [{ value: 'd1', label: 'Dr Sow' }], sites: [{ value: 's1', label: 'Principal' }], date: '2026-10-04' };

beforeEach(() => {
  searchPatientsAction.mockReset();
});

describe('AppointmentBooking', () => {
  it('cherche le patient par POST puis affiche le formulaire de rendez-vous, et permet de changer de patient', async () => {
    searchPatientsAction.mockResolvedValue({
      ok: true,
      values: { q: 'Awa' },
      extra: { patients: [{ id: 'p1', fullName: 'Awa NDIAYE', recordNumber: 'P26-0000001', sex: 'female', birthDate: '', birthDateEstimated: false, city: '' }], nextCursor: null, paged: false },
    });
    const user = userEvent.setup();
    render(<AppointmentBooking {...props} />);
    await user.click(screen.getByRole('button', { name: 'Rechercher' }));
    await user.click(await screen.findByRole('button', { name: 'Choisir Awa NDIAYE' }));
    expect(screen.getByText('Awa NDIAYE')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Créer le rendez-vous' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Choisir un autre patient' }));
    expect(screen.getByRole('search')).toBeInTheDocument();
  });

  it('démarre directement sur le formulaire si le patient est connu', () => {
    render(<AppointmentBooking {...props} initialPatient={{ id: 'p1', fullName: 'Awa NDIAYE' }} />);
    expect(screen.getByRole('button', { name: 'Créer le rendez-vous' })).toBeInTheDocument();
  });
});
