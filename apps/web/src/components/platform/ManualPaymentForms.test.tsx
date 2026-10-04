import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/actions/platform-console', () => ({
  recordManualPaymentAction: vi.fn(),
  validateManualPaymentAction: vi.fn(),
  rejectManualPaymentAction: vi.fn(),
}));

import { DecideManualPayment, RecordManualPaymentForm } from './ManualPaymentForms';

describe('RecordManualPaymentForm', () => {
  it('préremplit le montant exact de la facture sans les centimes nuls', () => {
    render(<RecordManualPaymentForm invoiceId="11111111-1111-4111-8111-111111111111" total="25000.00" />);
    expect(screen.getByLabelText(/Montant reçu/)).toHaveValue('25000');
    expect(screen.getByLabelText(/Mode/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Référence/)).toBeRequired();
    expect(screen.getByLabelText(/Date de réception/)).toHaveAttribute('type', 'date');
    expect(screen.getByRole('button', { name: 'Saisir le paiement' })).toBeInTheDocument();
  });
});

describe('DecideManualPayment', () => {
  it('propose la validation et le rejet motivé', () => {
    render(<DecideManualPayment paymentId="22222222-2222-4222-8222-222222222222" />);
    expect(screen.getByRole('button', { name: 'Valider le paiement' })).toBeInTheDocument();
    expect(screen.getByText('Rejeter')).toBeInTheDocument();
    expect(screen.getByLabelText(/Motif du rejet/)).toBeRequired();
  });
});
