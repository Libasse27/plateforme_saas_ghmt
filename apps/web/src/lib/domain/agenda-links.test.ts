import { describe, expect, it } from 'vitest';
import { agendaHref } from './agenda-links';

describe('agendaHref', () => {
  it('retourne la racine sans paramètre', () => {
    expect(agendaHref({})).toBe('/rendez-vous');
    expect(agendaHref({ date: '', practitionerId: undefined })).toBe('/rendez-vous');
  });
  it('n\'accepte plus de terme de recherche dans l\'URL', () => {
    expect(agendaHref({ pq: 'Diallo' } as never)).toBe('/rendez-vous');
  });
  it('encode et ordonne les paramètres renseignés', () => {
    expect(agendaHref({ date: '2026-10-04', practitionerId: 'd1', patientId: 'p1', nouveau: true })).toBe(
      '/rendez-vous?date=2026-10-04&practitionerId=d1&patientId=p1&nouveau=1',
    );
  });
});

describe('agendaHref ipp', () => {
  it('transmet l\'IPP (identifiant, jamais un nom)', () => {
    expect(agendaHref({ patientId: 'p1', ipp: 'P26-0000001', nouveau: true })).toBe('/rendez-vous?patientId=p1&ipp=P26-0000001&nouveau=1');
  });
});
