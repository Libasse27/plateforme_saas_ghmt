import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ActionForm, type FieldSpec } from './ActionForm';

const FIELDS: FieldSpec[] = [
  { kind: 'text', name: 'code', label: 'Code', required: true, hint: 'Lettres et chiffres' },
  { kind: 'select', name: 'category', label: 'Catégorie', options: [{ value: 'acte', label: 'Acte' }, { value: 'examen', label: 'Examen' }], defaultValue: 'examen' },
  { kind: 'checkbox', name: 'isDefault', label: 'Grille par défaut' },
  { kind: 'textarea', name: 'notes', label: 'Notes' },
];

describe('ActionForm', () => {
  it('rend des champs étiquetés et soumet valeurs et champs cachés à l\'action', async () => {
    const action = vi.fn().mockResolvedValue({ ok: true, message: 'Enregistré.' });
    const user = userEvent.setup();
    render(<ActionForm action={action} fields={FIELDS} hidden={{ invoiceId: 'inv-1' }} submitLabel="Créer" />);
    await user.type(screen.getByLabelText(/Code/), 'STD');
    await user.selectOptions(screen.getByLabelText('Catégorie'), 'acte');
    await user.click(screen.getByLabelText('Grille par défaut'));
    await user.type(screen.getByLabelText('Notes'), 'RAS');
    await user.click(screen.getByRole('button', { name: 'Créer' }));
    await waitFor(() => expect(action).toHaveBeenCalled());
    const data = action.mock.calls[0]?.[1] as FormData;
    expect(data.get('code')).toBe('STD');
    expect(data.get('category')).toBe('acte');
    expect(data.get('isDefault')).toBe('on');
    expect(data.get('notes')).toBe('RAS');
    expect(data.get('invoiceId')).toBe('inv-1');
    expect(await screen.findByRole('status')).toHaveTextContent('Enregistré.');
  });

  it('affiche les erreurs par champ avec aria-invalid et le message global en alerte', async () => {
    const action = vi.fn().mockResolvedValue({ ok: false, message: 'Certains champs sont invalides.', fieldErrors: { code: 'Code déjà utilisé.' }, values: { code: 'STD' } });
    const user = userEvent.setup();
    render(<ActionForm action={action} fields={FIELDS} submitLabel="Créer" />);
    await user.type(screen.getByLabelText(/Code/), 'STD');
    await user.click(screen.getByRole('button', { name: 'Créer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Certains champs sont invalides.');
    expect(screen.getByLabelText(/Code/)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Code déjà utilisé.')).toBeInTheDocument();
    expect(screen.getByLabelText(/Code/)).toHaveValue('STD');
  });

  it('affiche les instructions et le lien de paiement renvoyés par l\'action', async () => {
    const action = vi.fn().mockResolvedValue({ ok: true, message: 'Demande envoyée.', extra: { instructions: 'Validez sur votre téléphone.', checkoutUrl: 'https://pay.test/abc' } });
    const user = userEvent.setup();
    render(<ActionForm action={action} fields={[]} submitLabel="Payer" />);
    await user.click(screen.getByRole('button', { name: 'Payer' }));
    expect(await screen.findByText('Validez sur votre téléphone.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Continuer vers le paiement/ })).toHaveAttribute('href', 'https://pay.test/abc');
  });

  it('n\'affiche pas de lien de paiement non http(s)', async () => {
    const action = vi.fn().mockResolvedValue({ ok: true, extra: { checkoutUrl: 'javascript:alert(1)' } });
    const user = userEvent.setup();
    render(<ActionForm action={action} fields={[]} submitLabel="Payer" />);
    await user.click(screen.getByRole('button', { name: 'Payer' }));
    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('applique le style danger au bouton', () => {
    render(<ActionForm action={vi.fn()} fields={[]} submitLabel="Supprimer" variant="danger" />);
    expect(screen.getByRole('button', { name: 'Supprimer' }).className).toContain('bg-red-700');
  });
});
