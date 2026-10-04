import { describe, expect, it } from 'vitest';
import { groupByPractitioner, parseCandidatesJson, toAppointment, toDuplicateCandidates, toList, toPatient, toPractitioner, toSite } from './mappers';

describe('toPatient', () => {
  it('mappe la forme de docs/03 (adresse objet)', () => {
    const p = toPatient({
      id: 'p1', firstName: 'Moussa', lastName: 'Traoré', medicalRecordNumber: 'P-2026-004217', sex: 'male', birthDate: '1988-03-14',
      phone: '+22507123456', address: { line1: 'Riviera 3', city: 'Abidjan', country: 'CI' }, bloodGroup: 'O+',
    });
    expect(p.fullName).toBe('Moussa TRAORÉ');
    expect(p.recordNumber).toBe('P-2026-004217');
    expect(p.address).toBe('Riviera 3, Abidjan, CI');
  });
  it('mappe la forme du schéma partagé (adresse chaîne + ville)', () => {
    expect(toPatient({ id: 'p', address: 'Rue 1', city: 'Dakar', ipp: 'X1', fullName: 'A B' })).toMatchObject({ address: 'Rue 1, Dakar', recordNumber: 'X1', fullName: 'A B' });
  });
  it('tolère des données absentes', () => {
    const p = toPatient(null);
    expect(p.fullName).toBe('Patient sans nom');
    expect(p.id).toBe('');
  });
});

describe('toAppointment / praticiens / sites', () => {
  it('mappe patient et praticien imbriqués', () => {
    const a = toAppointment({
      id: 'a1', status: 'confirmed', startsAt: 's', endsAt: 'e', reason: 'Suivi',
      patient: { id: 'p1', fullName: 'Moussa Traoré' }, practitioner: { id: 'd1', fullName: 'Dr Diallo' },
    });
    expect(a).toMatchObject({ patientId: 'p1', patientName: 'Moussa Traoré', practitionerId: 'd1', practitionerName: 'Dr Diallo', status: 'confirmed' });
  });
  it('mappe les identifiants à plat et un statut inconnu', () => {
    const a = toAppointment({ id: 'a', status: '???', patientId: 'p', practitionerId: 'd', patientName: 'X' });
    expect(a).toMatchObject({ status: 'unknown', patientId: 'p', practitionerId: 'd', patientName: 'X', practitionerName: 'Praticien' });
    expect(toAppointment({ patient: { firstName: 'A', lastName: 'b' } }).patientName).toBe('A B');
    expect(toAppointment(undefined).patientName).toBe('Patient');
  });
  it('praticiens et sites', () => {
    expect(toPractitioner({ id: 'd', name: 'Dr X', specialty: 'ORL' })).toEqual({ id: 'd', fullName: 'Dr X', specialty: 'ORL' });
    expect(toPractitioner({}).fullName).toBe('Praticien');
    expect(toSite({ id: 's', code: 'MAIN', city: 'Dakar' })).toEqual({ id: 's', name: 'MAIN', city: 'Dakar' });
    expect(toSite({}).name).toBe('Site');
  });
  it('toList accepte un tableau, { items } ou autre chose', () => {
    expect(toList([{ id: 'a' }], toSite)).toHaveLength(1);
    expect(toList({ items: [{ id: 'a' }, { id: 'b' }] }, toSite)).toHaveLength(2);
    expect(toList('x', toSite)).toEqual([]);
    expect(toList({ items: 3 }, toSite)).toEqual([]);
  });
});

describe('C1/C2/C3/C4 : nouvelles formes', () => {
  it('toPatient lit ipp, ville, date estimée (résultat de recherche)', () => {
    const p = toPatient({ id: 'p', ipp: 'P26-0000001', firstName: 'A', lastName: 'b', sex: 'female', birthDate: '1990-01-01', birthDateEstimated: true, city: 'Dakar' });
    expect(p).toMatchObject({ recordNumber: 'P26-0000001', city: 'Dakar', birthDateEstimated: true });
    expect(toPatient({ id: 'p' }).birthDateEstimated).toBe(false);
  });
  it('toAppointment lit patient.ipp/birthYear et praticien C2, motif absent toléré', () => {
    const a = toAppointment({
      id: 'a', status: 'scheduled', startsAt: 's', endsAt: 'e',
      patient: { id: 'p', ipp: 'P26-0000001', fullName: 'Awa Ndiaye', birthYear: 1990 },
      practitioner: { id: 'd', fullName: 'Dr Sow', specialty: 'ORL' },
    });
    expect(a).toMatchObject({ patientIpp: 'P26-0000001', patientBirthYear: 1990, reason: '', practitionerSpecialty: 'ORL' });
    expect(toAppointment({ patient: { birthYear: null } }).patientBirthYear).toBeNull();
    expect(toAppointment({}).patientBirthYear).toBeNull();
  });
  it('groupByPractitioner utilise la spécialité des rendez-vous quand /practitioners est interdit', () => {
    const appts = [toAppointment({ id: 'a', practitioner: { id: 'd', fullName: 'Dr Sow', specialty: 'ORL' }, startsAt: 'x' })];
    expect(groupByPractitioner(appts, [])[0]?.practitioner).toEqual({ id: 'd', fullName: 'Dr Sow', specialty: 'ORL' });
  });
  it('toDuplicateCandidates lit details.candidates (C3) avec ipp et année de naissance', () => {
    expect(toDuplicateCandidates({ details: { candidates: [{ id: 'x', ipp: 'P26-0000002', fullName: 'A B', birthYear: 1988 }] } })).toEqual([
      { id: 'x', fullName: 'A B', recordNumber: 'P26-0000002', birthYear: 1988 },
    ]);
  });
});

describe('doublons', () => {
  it('extrait les candidats valides', () => {
    expect(toDuplicateCandidates({ candidates: [{ id: 'x', fullName: 'A B', medicalRecordNumber: 'P-1' }, { name: 'sans id' }] })).toEqual([
      { id: 'x', fullName: 'A B', recordNumber: 'P-1', birthYear: null },
    ]);
    expect(toDuplicateCandidates({})).toEqual([]);
  });
});

describe('groupByPractitioner', () => {
  const doc1 = { id: 'd1', fullName: 'Dr A', specialty: '' };
  const doc2 = { id: 'd2', fullName: 'Dr B', specialty: '' };
  const mk = (id: string, practitionerId: string, startsAt: string, name = 'Dr ?') =>
    toAppointment({ id, practitionerId, startsAt, practitionerName: name, status: 'scheduled' });

  it('regroupe, trie par heure et conserve les praticiens sans rendez-vous', () => {
    const groups = groupByPractitioner([mk('2', 'd1', '2026-10-04T10:00:00Z'), mk('1', 'd1', '2026-10-04T08:00:00Z')], [doc1, doc2]);
    expect(groups.map((g) => g.practitioner.id)).toEqual(['d1', 'd2']);
    expect(groups[0]?.appointments.map((a) => a.id)).toEqual(['1', '2']);
    expect(groups[1]?.appointments).toEqual([]);
  });
  it('ajoute un groupe pour un praticien absent de la liste', () => {
    const groups = groupByPractitioner([mk('1', 'd9', '2026-10-04T08:00:00Z', 'Dr Inconnu')], [doc1]);
    expect(groups.map((g) => g.practitioner.fullName)).toEqual(['Dr A', 'Dr Inconnu']);
  });
});

describe('parseCandidatesJson', () => {
  it('relit et re-normalise les candidats, limités à 5', () => {
    const json = JSON.stringify(Array.from({ length: 7 }, (_, i) => ({ id: `id${String(i)}`, fullName: 'A B', recordNumber: 'P26-0000001' })));
    expect(parseCandidatesJson(json)).toHaveLength(5);
  });
  it('renvoie une liste vide pour un JSON absent ou invalide', () => {
    expect(parseCandidatesJson(undefined)).toEqual([]);
    expect(parseCandidatesJson('{pas du json')).toEqual([]);
    expect(parseCandidatesJson('"texte"')).toEqual([]);
  });
});

describe('re-revue : décès, coordonnées masquées, statut inconnu, nom', () => {
  it('toPatient lit deceasedAt et contactRedacted (défauts sûrs)', () => {
    expect(toPatient({ id: 'p', deceasedAt: '2026-09-30', contactRedacted: true })).toMatchObject({ deceasedAt: '2026-09-30', contactRedacted: true });
    expect(toPatient({ id: 'p', deceasedAt: null })).toMatchObject({ deceasedAt: null, contactRedacted: false });
    expect(toPatient({ id: 'p', deceasedAt: '', contactRedacted: 'oui' })).toMatchObject({ deceasedAt: null, contactRedacted: false });
  });
  it('toAppointment lit patient.deceasedAt', () => {
    expect(toAppointment({ patient: { id: 'p', deceasedAt: '2026-09-30T00:00:00Z' } }).patientDeceasedAt).toBe('2026-09-30T00:00:00Z');
    expect(toAppointment({ patient: { id: 'p', deceasedAt: null } }).patientDeceasedAt).toBeNull();
    expect(toAppointment({}).patientDeceasedAt).toBeNull();
  });
  it('un statut de rendez-vous inconnu ou absent est « unknown », jamais « scheduled »', () => {
    expect(toAppointment({ status: 'archived' }).status).toBe('unknown');
    expect(toAppointment({}).status).toBe('unknown');
    expect(toAppointment({ status: 'no_show' }).status).toBe('no_show');
  });
  it('le nom suit « Prénom NOM » (fullName de l\'API sinon reconstruction)', () => {
    expect(toPatient({ fullName: 'Awa NDIAYE', firstName: 'x', lastName: 'y' }).fullName).toBe('Awa NDIAYE');
    expect(toPatient({ firstName: 'Awa', lastName: 'Ndiaye' }).fullName).toBe('Awa NDIAYE');
    expect(toPatient({ lastName: 'Ndiaye' }).fullName).toBe('NDIAYE');
    expect(toAppointment({ patient: { firstName: 'Awa', lastName: 'Ndiaye' } }).patientName).toBe('Awa NDIAYE');
    expect(toDuplicateCandidates({ candidates: [{ id: '1', firstName: 'Awa', lastName: 'Ndiaye' }] })[0]?.fullName).toBe('Awa NDIAYE');
    expect(toDuplicateCandidates({ candidates: [{ id: '1', fullName: 'Awa NDIAYE' }] })[0]?.fullName).toBe('Awa NDIAYE');
  });
});
