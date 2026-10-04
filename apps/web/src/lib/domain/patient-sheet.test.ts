import { describe, expect, it } from 'vitest';
import { deceasedBanner, patientSheetRows } from './patient-sheet';
import { toPatient } from './mappers';

const base = { id: 'p', firstName: 'Awa', lastName: 'Ndiaye', ipp: 'P26-0000001', sex: 'female', birthDate: '1990-01-01', phone: '+221771234567', email: 'a@b.sn', address: 'Rue 1', city: 'Dakar', bloodGroup: 'O+' };
const rowMap = (raw: object) => Object.fromEntries(patientSheetRows(toPatient(raw)));

describe('patientSheetRows', () => {
  it('affiche les coordonnées quand elles sont présentes', () => {
    const rows = rowMap(base);
    expect(rows['Téléphone']).toBe('+221771234567');
    expect(rows['E-mail']).toBe('a@b.sn');
  });
  it('contactRedacted : « Coordonnées masquées (droits insuffisants) » au lieu de « - »', () => {
    const rows = rowMap({ ...base, phone: undefined, email: undefined, address: undefined, city: undefined, contactRedacted: true });
    for (const label of ['Téléphone', 'E-mail', 'Adresse']) expect(rows[label]).toBe('Coordonnées masquées (droits insuffisants)');
    expect(rows['Groupe sanguin']).toBe('O+');
  });
  it('coordonnées vides non masquées : valeur vide (le « - » est rendu par la page)', () => {
    expect(rowMap({ ...base, phone: undefined })['Téléphone']).toBe('');
  });
});

describe('deceasedBanner', () => {
  it('null si vivant', () => {
    expect(deceasedBanner(toPatient(base))).toBeNull();
  });
  it('« Patient décédé le … » en français', () => {
    expect(deceasedBanner(toPatient({ ...base, deceasedAt: '2026-09-30' }))).toBe('Patient décédé le 30/09/2026');
  });
  it('date illisible : mention sans date', () => {
    expect(deceasedBanner(toPatient({ ...base, deceasedAt: 'n/a' }))).toBe('Patient décédé');
  });
});
