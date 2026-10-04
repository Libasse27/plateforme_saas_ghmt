import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const searchPatientsAction = vi.fn();
vi.mock('@/actions/patients', () => ({ searchPatientsAction: (...args: unknown[]) => searchPatientsAction(...args) }));

import { PatientSearch } from './PatientSearch';

const patient = { id: 'p1', fullName: 'Awa NDIAYE', recordNumber: 'P26-0000001', sex: 'female', birthDate: '1990-01-01', birthDateEstimated: true, city: 'Dakar' };

beforeEach(() => {
  searchPatientsAction.mockReset();
});

describe('PatientSearch', () => {
  it('envoie la recherche par Server Action (POST), sans formulaire GET', async () => {
    searchPatientsAction.mockResolvedValue({ ok: true, values: { q: 'Ndiaye' }, extra: { patients: [patient], nextCursor: null, paged: false } });
    const user = userEvent.setup();
    render(<PatientSearch />);
    expect(screen.getByRole('search')).not.toHaveAttribute('method', 'get');
    await user.type(screen.getByLabelText(/Nom, téléphone/), 'Ndiaye');
    await user.click(screen.getByRole('button', { name: 'Rechercher' }));
    expect(await screen.findByRole('link', { name: 'Awa NDIAYE' })).toHaveAttribute('href', '/patients/p1');
    expect((searchPatientsAction.mock.calls[0]?.[1] as FormData).get('q')).toBe('Ndiaye');
    expect(screen.getByText('(estimée)')).toBeInTheDocument();
    expect(screen.getByText('Dakar')).toBeInTheDocument();
    expect(screen.queryByText('Téléphone')).not.toBeInTheDocument();
  });

  it('affiche un message quand rien ne correspond', async () => {
    searchPatientsAction.mockResolvedValue({ ok: true, values: { q: 'zzz' }, extra: { patients: [], nextCursor: null, paged: false } });
    const user = userEvent.setup();
    render(<PatientSearch />);
    await user.click(screen.getByRole('button', { name: 'Rechercher' }));
    expect(await screen.findByText(/Aucun patient ne correspond/)).toBeInTheDocument();
  });

  it('affiche l\'erreur de saisie', async () => {
    searchPatientsAction.mockResolvedValue({ ok: false, message: 'Saisissez au moins 2 caractères.', values: { q: 'a' } });
    const user = userEvent.setup();
    render(<PatientSearch />);
    await user.click(screen.getByRole('button', { name: 'Rechercher' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('au moins 2 caractères');
  });

  it('pagine avec le seul curseur opaque (le terme est rejoué dans le corps du POST)', async () => {
    searchPatientsAction
      .mockResolvedValueOnce({ ok: true, values: { q: 'Ndiaye' }, extra: { patients: [patient], nextCursor: 'CUR1', paged: false } })
      .mockResolvedValueOnce({ ok: true, values: { q: 'Ndiaye' }, extra: { patients: [], nextCursor: null, paged: true } });
    const user = userEvent.setup();
    render(<PatientSearch />);
    await user.click(screen.getByRole('button', { name: 'Rechercher' }));
    await user.click(await screen.findByRole('button', { name: 'Page suivante' }));
    const form = searchPatientsAction.mock.calls[1]?.[1] as FormData;
    expect(form.get('cursor')).toBe('CUR1');
    expect(form.get('q')).toBe('Ndiaye');
    expect(await screen.findByRole('button', { name: 'Retour au début' })).toBeInTheDocument();
  });

  it('en mode choix, un bouton remplace le lien vers la fiche', async () => {
    searchPatientsAction.mockResolvedValue({ ok: true, values: { q: 'N' }, extra: { patients: [patient], nextCursor: null, paged: false } });
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<PatientSearch onSelect={onSelect} />);
    await user.click(screen.getByRole('button', { name: 'Rechercher' }));
    await user.click(await screen.findByRole('button', { name: 'Choisir Awa NDIAYE' }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }));
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
