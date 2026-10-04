import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createPatientAction = vi.fn();
vi.mock('@/actions/patients', () => ({ createPatientAction: (...args: unknown[]) => createPatientAction(...args) }));

import { PatientForm } from './PatientForm';

const props = {
  sexOptions: [{ value: 'male', label: 'Masculin' }, { value: 'female', label: 'Féminin' }],
  bloodGroupOptions: [{ value: 'O+', label: 'O+' }],
};

beforeEach(() => {
  createPatientAction.mockReset();
});

describe('PatientForm', () => {
  it('affiche les champs du schéma patient en français', () => {
    render(<PatientForm {...props} />);
    for (const label of ['Nom', 'Prénom', 'Sexe', 'Date de naissance', 'Téléphone', 'Adresse e-mail', 'Groupe sanguin', 'Ville']) {
      expect(screen.getByLabelText(new RegExp(`^${label}( \\*)?$`))).toBeInTheDocument();
    }
    expect(screen.getByRole('option', { name: 'Masculin' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Téléphone/)).toHaveAccessibleDescription(/Format international/);
  });

  it('montre les erreurs 422 par champ et conserve les valeurs saisies', async () => {
    createPatientAction.mockResolvedValue({
      ok: false,
      message: 'Certains champs sont invalides. Corrigez-les puis réessayez.',
      fieldErrors: { firstName: 'Ce champ est obligatoire.', phone: 'téléphone au format E.164, ex. +221771234567' },
      values: { lastName: 'Traoré', phone: '0707' },
    });
    const user = userEvent.setup();
    render(<PatientForm {...props} />);
    await user.click(screen.getByRole('button', { name: /Enregistrer/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Certains champs sont invalides');
    expect(screen.getByLabelText(/Prénom/)).toHaveAccessibleDescription('Ce champ est obligatoire.');
    expect(screen.getByLabelText(/Téléphone/)).toHaveAccessibleDescription(/E\.164/);
    expect(screen.getByLabelText(/^Nom/)).toHaveValue('Traoré');
  });

  it('liste les dossiers candidats lors d\'un doublon suspecté (409)', async () => {
    createPatientAction.mockResolvedValue({
      ok: false,
      message: 'Un patient très proche existe déjà.',
      extra: { candidates: [{ id: 'abc', fullName: 'Moussa Traoré', recordNumber: 'P-2025-001873' }] },
    });
    const user = userEvent.setup();
    render(<PatientForm {...props} />);
    await user.click(screen.getByRole('button', { name: /Enregistrer/ }));

    const link = await screen.findByRole('link', { name: 'Moussa Traoré' });
    expect(link).toHaveAttribute('href', '/patients/abc');
    expect(screen.getByText(/P-2025-001873/)).toBeInTheDocument();
  });

  it('propose « Créer quand même » avec un motif et renvoie force + candidats', async () => {
    createPatientAction.mockResolvedValue({
      ok: false,
      message: 'Un patient très proche existe déjà.',
      extra: { candidates: [{ id: 'abc', fullName: 'Moussa Traoré', recordNumber: 'P26-0000002', birthYear: 1988 }] },
    });
    const user = userEvent.setup();
    render(<PatientForm {...props} />);
    await user.click(screen.getByRole('button', { name: /Enregistrer/ }));
    expect(await screen.findByText(/né\(e\) en 1988/)).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Motif de création/), 'Homonyme confirmé');
    await user.click(screen.getByRole('button', { name: 'Créer quand même' }));
    const form = createPatientAction.mock.calls[1]?.[1] as FormData;
    expect(form.get('force')).toBe('1');
    expect(form.get('forceReason')).toBe('Homonyme confirmé');
    expect(JSON.parse(String(form.get('candidatesJson')))).toHaveLength(1);
  });

  it('doublon hors périmètre : message dédié, aucun candidat, « Créer quand même » + motif', async () => {
    createPatientAction.mockResolvedValue({
      ok: false,
      message: 'Un dossier correspondant existe dans un autre site. Vérifiez auprès de l\'identitovigilance ou créez le dossier en indiquant un motif.',
      extra: { candidates: [], forceable: true },
    });
    const user = userEvent.setup();
    render(<PatientForm {...props} />);
    await user.click(screen.getByRole('button', { name: /Enregistrer/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('existe dans un autre site');
    expect(screen.queryByText('Dossiers existants proches :')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(/Motif de création/), 'Transfert confirmé');
    await user.click(screen.getByRole('button', { name: 'Créer quand même' }));
    const form = createPatientAction.mock.calls[1]?.[1] as FormData;
    expect(form.get('force')).toBe('1');
    expect(form.get('forceReason')).toBe('Transfert confirmé');
  });

  it('n\'affiche pas « Créer quand même » sans doublon', () => {
    render(<PatientForm {...props} />);
    expect(screen.queryByRole('button', { name: 'Créer quand même' })).not.toBeInTheDocument();
  });
});
