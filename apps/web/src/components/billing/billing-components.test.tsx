import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { toInvoiceDetail, toReceipt } from '@/lib/domain/billing';

vi.mock('@/actions/payments', () => ({ abandonPaymentAction: vi.fn(), refreshPaymentAction: vi.fn(), recordPaymentAction: vi.fn() }));
vi.mock('@/actions/billing-pricing', () => ({ updatePriceItemAction: vi.fn() }));
vi.mock('@/actions/cashier', () => ({ closeSessionAction: vi.fn(), forceCloseSessionAction: vi.fn(), validateSessionAction: vi.fn() }));

import { CloseSessionForm } from '../cashier/CloseSessionForm';
import { SessionsTable } from '../cashier/SessionsTable';
import { AbandonPayment } from './AbandonPayment';
import { InvoiceLinesTable, PaymentsTable } from './InvoiceTables';
import { PaymentForm } from './PaymentForm';
import { PriceItemsTable } from './PriceItemsTable';
import { Receipt } from './Receipt';

const ID = '11111111-1111-4111-8111-111111111111';
const LINE = { id: 'l1', lineNo: 1, category: 'examen', description: 'Test VIH', quantity: '1', unitPrice: '5000.00', lineTotal: '5000.00', isSensitive: true, printLabel: 'Examen biologique' };
const INVOICE = {
  id: ID, number: 'FAC-1', status: 'issued', currency: 'XOF', total: '5000.00', amountPaid: '0.00', balance: '5000.00', createdAt: '2026-10-04T08:00:00.000Z',
  patient: { id: 'p', ipp: 'P26-0000001', fullName: null, identityMasked: true }, lines: [LINE], payments: [],
};

describe('Reçu', () => {
  it('utilise exclusivement le libellé imprimable et masque l\'identité', () => {
    render(<Receipt receipt={toReceipt({ establishment: 'Clinique', site: 'Plateau', invoice: INVOICE, printedAt: '2026-10-04T09:00:00.000Z' })} timeZone="Africa/Dakar" />);
    expect(screen.getByText(/Examen biologique/)).toBeInTheDocument();
    expect(screen.queryByText(/VIH/)).not.toBeInTheDocument();
    expect(screen.getByText('Patient P26-0000001')).toBeInTheDocument();
    expect(screen.queryByTestId('receipt-watermark')).not.toBeInTheDocument();
  });
  it('affiche le filigrane « ANNULÉE » pour une facture annulée', () => {
    render(<Receipt receipt={toReceipt({ invoice: { ...INVOICE, status: 'void' }, voided: true })} timeZone="Africa/Dakar" />);
    expect(screen.getByTestId('receipt-watermark')).toHaveTextContent('ANNULÉE');
  });
});

describe('Lignes et grille', () => {
  it('affiche le libellé masqué', () => {
    const detail = toInvoiceDetail({ ...INVOICE, lines: [{ ...LINE, labelMasked: true, description: 'Test VIH' }] });
    render(<InvoiceLinesTable lines={detail.lines} currency="XOF" />);
    expect(screen.getByText('Examen biologique')).toBeInTheDocument();
    expect(screen.queryByText('Test VIH')).not.toBeInTheDocument();
  });
  it('grille : champs « Acte sensible » et « Libellé imprimé » pour qui peut modifier', () => {
    const item = { id: ID, priceListId: 'g', code: 'C1', label: 'Test VIH', category: 'examen' as const, unitPrice: '5000.00', isActive: true, isSensitive: true, printLabel: 'Examen biologique', labelMasked: false };
    render(<PriceItemsTable items={[item]} currency="XOF" canUpdate />);
    expect(screen.getByRole('checkbox', { name: /Acte sensible/ })).toBeChecked();
    expect(screen.getByLabelText('Libellé imprimé')).toHaveValue('Examen biologique');
    expect(screen.getByText('Sensible')).toBeInTheDocument();
  });
  it('grille : libellé masqué pour un lecteur sans droit clinique', () => {
    const item = { id: ID, priceListId: 'g', code: 'C1', label: 'Test VIH', category: 'examen' as const, unitPrice: '5000.00', isActive: true, isSensitive: true, printLabel: null, labelMasked: true };
    render(<PriceItemsTable items={[item]} currency="XOF" canUpdate={false} />);
    expect(screen.getAllByText('Examen')).toHaveLength(2); // libellé neutre + catégorie
    expect(screen.queryByText('Test VIH')).not.toBeInTheDocument();
  });
});

describe('Abandon du paiement en ligne (R4)', () => {
  it('demande une confirmation avant d\'abandonner', () => {
    render(<AbandonPayment paymentId={ID} invoiceId={ID} />);
    fireEvent.click(screen.getByRole('button', { name: 'Abandonner le paiement en ligne' }));
    expect(screen.getByRole('button', { name: 'Confirmer l\'abandon' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Garder le paiement' }));
    expect(screen.getByRole('button', { name: 'Abandonner le paiement en ligne' })).toBeInTheDocument();
  });
  it('le bouton figure sur un paiement Mobile Money en attente, avec l\'anomalie de trop-perçu', () => {
    const payments = [
      { id: ID, method: 'mobile_money' as const, amount: '5000.00', currency: 'XOF', status: 'pending' as const, paidAt: null, cashSessionId: null, reference: null, provider: 'x', checkoutUrl: null, failureReason: null, createdAt: '2026-10-04T08:00:00.000Z', anomaly: null },
      { id: '22222222-2222-4222-8222-222222222222', method: 'cash' as const, amount: '1.00', currency: 'XOF', status: 'succeeded' as const, paidAt: null, cashSessionId: null, reference: null, provider: null, checkoutUrl: null, failureReason: null, createdAt: '2026-10-04T08:00:00.000Z', anomaly: 'overpaid' },
    ];
    render(<PaymentsTable payments={payments} invoiceId={ID} timeZone="Africa/Dakar" canRefresh />);
    expect(screen.getAllByRole('button', { name: 'Abandonner le paiement en ligne' })).toHaveLength(1);
    expect(screen.getByText(/trop-perçu/)).toBeInTheDocument();
  });
});

describe('PaymentForm (R9)', () => {
  const props = { invoiceId: ID, currency: 'XOF', balance: '5000.00', canSeeCashier: true };
  it('le mode « autre » sans session ouverte est bloqué', () => {
    render(<PaymentForm {...props} cashSessionId={null} />);
    fireEvent.click(screen.getByLabelText('Autre mode'));
    expect(screen.getByText(/ouvrir une session de caisse/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Encaisser' })).not.toBeInTheDocument();
  });
  it('avec une session ouverte, le mode « autre » reste possible', () => {
    render(<PaymentForm {...props} cashSessionId={ID} />);
    fireEvent.click(screen.getByLabelText('Autre mode'));
    expect(screen.getByRole('button', { name: 'Encaisser' })).toBeInTheDocument();
  });
});

describe('Clôture de caisse (R8)', () => {
  it('calcule l\'écart et exige une note s\'il n\'est pas nul', () => {
    render(<CloseSessionForm sessionId={ID} currency="XOF" expectedTotal="60000.00" />);
    fireEvent.change(screen.getByLabelText(/Montant compté/), { target: { value: '59 000' } });
    expect(screen.getByText(/écart : -1/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Note \(obligatoire/)).toBeRequired();
    fireEvent.click(screen.getByRole('button', { name: 'Clôturer la session' }));
    expect(screen.getByText(/écart est non nul/)).toBeInTheDocument();
  });
  it('note facultative quand l\'écart est nul ou la saisie invalide', () => {
    render(<CloseSessionForm sessionId={ID} currency="XOF" expectedTotal="60000.00" />);
    fireEvent.change(screen.getByLabelText(/Montant compté/), { target: { value: '60000' } });
    expect(screen.getByLabelText(/Note \(facultative\)/)).not.toBeRequired();
    fireEvent.change(screen.getByLabelText(/Montant compté/), { target: { value: '1,5' } });
    expect(screen.getByText(/sans décimales/)).toBeInTheDocument();
  });
  it('clôture forcée proposée sur les sessions ouvertes des autres seulement', () => {
    const base = { cashRegisterId: 'r', status: 'open' as const, currency: 'XOF', openedAt: '2026-10-04T08:00:00.000Z', openingFloat: '0.00', expectedTotal: '1000.00', closedBy: null, closedAt: null, closingCounted: null, variance: null, validatedBy: null, validatedAt: null, forceClosed: false };
    render(
      <SessionsTable
        sessions={[{ ...base, id: 's1', openedBy: 'autre' }, { ...base, id: 's2', openedBy: 'moi' }]}
        registerNames={{ r: 'Caisse 1' }}
        timeZone="Africa/Dakar"
        caption="Sessions ouvertes"
        currentUserId="moi"
        canForceClose
      />,
    );
    expect(screen.getAllByText('Clôture forcée')).toHaveLength(2); // en-tête + un seul bouton
    expect(screen.getByLabelText(/Motif \(obligatoire\)/)).toBeRequired();
    expect(screen.getByText(/clôturez-la vous-même/)).toBeInTheDocument();
  });
});
