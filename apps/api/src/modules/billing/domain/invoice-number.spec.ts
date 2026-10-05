import { describe, expect, it } from 'vitest';
import { formatInvoiceNumber, invoiceYearOf } from './invoice-number';

describe('numéro de facture FAC-{AAAA}-{000001}', () => {
  it('complète à 6 chiffres', () => {
    expect(formatInvoiceNumber(2026, 1n)).toBe('FAC-2026-000001');
    expect(formatInvoiceNumber(2026, 123456n)).toBe('FAC-2026-123456');
  });

  it('ne tronque pas au-delà de 6 chiffres', () => {
    expect(formatInvoiceNumber(2026, 1234567n)).toBe('FAC-2026-1234567');
  });

  it('prend l’année dans le fuseau de l’établissement (changement d’année local)', () => {
    const newYearEveUtc = new Date('2026-12-31T23:30:00Z');

    expect(invoiceYearOf(newYearEveUtc, 'Africa/Dakar')).toBe(2026);
    expect(invoiceYearOf(newYearEveUtc, 'Africa/Lagos')).toBe(2027);
  });
});
