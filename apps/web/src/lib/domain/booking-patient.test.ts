import { describe, expect, it, vi } from 'vitest';
import { isIpp, loadBookingPatient } from './booking-patient';

const ID = '11111111-1111-4111-8111-111111111111';

describe('isIpp', () => {
  it('valide le format IPP', () => {
    expect(isIpp('P26-0000001')).toBe(true);
    expect(isIpp('p26-0000001')).toBe(false);
    expect(isIpp('Traoré')).toBe(false);
    expect(isIpp(undefined)).toBe(false);
  });
});

describe('loadBookingPatient', () => {
  it('cherche par IPP (recherche minimale) et retrouve le patient par id', async () => {
    const search = vi.fn().mockResolvedValue({ items: [{ id: 'autre', ipp: 'P26-0000001', firstName: 'X', lastName: 'y' }, { id: ID, ipp: 'P26-0000001', firstName: 'Awa', lastName: 'Ndiaye' }] });
    await expect(loadBookingPatient(search, ID, 'P26-0000001')).resolves.toEqual({ id: ID, fullName: 'Awa NDIAYE' });
    expect(search).toHaveBeenCalledWith({ ipp: 'P26-0000001', limit: 20 });
  });
  it('sans IPP : aucune requête, libellé neutre', async () => {
    const search = vi.fn();
    await expect(loadBookingPatient(search, ID, undefined)).resolves.toEqual({ id: ID, fullName: 'Patient sélectionné' });
    expect(search).not.toHaveBeenCalled();
  });
  it('IPP mal formé : aucune requête', async () => {
    const search = vi.fn();
    await expect(loadBookingPatient(search, ID, 'Dupont')).resolves.toEqual({ id: ID, fullName: 'Patient sélectionné' });
    expect(search).not.toHaveBeenCalled();
  });
  it('patient introuvable dans les résultats : libellé neutre avec l\'IPP', async () => {
    const search = vi.fn().mockResolvedValue({ items: [] });
    await expect(loadBookingPatient(search, ID, 'P26-0000001')).resolves.toEqual({ id: ID, fullName: 'Patient sélectionné (P26-0000001)' });
  });
});
