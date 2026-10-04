import { describe, expect, it } from 'vitest';
import { birthYearWindow, buildSearchName, buildSwappedSearchName, formatIpp, formatPatientFullName, normalizeName, normalizeNationalId, toSearchPattern } from './patient-identity';

describe('formatIpp', () => {
  it('formate P{YY}-{séquence sur 7 chiffres}', () => {
    expect(formatIpp(42, new Date('2026-03-01T10:00:00Z'))).toBe('P26-0000042');
  });

  it('accepte un bigint et conserve les grands numéros', () => {
    expect(formatIpp(1234567n, new Date('2031-12-31T10:00:00Z'))).toBe('P31-1234567');
  });

  it('ne tronque pas une séquence dépassant 7 chiffres', () => {
    expect(formatIpp(12345678, new Date('2026-01-01T00:00:00Z'))).toBe('P26-12345678');
  });
});

describe('normalizeName', () => {
  it('met en minuscules et retire les accents', () => {
    expect(normalizeName('Éloïse N’DIAYE')).toBe('eloise n’diaye');
  });

  it('réduit les espaces multiples et rogne', () => {
    expect(normalizeName('  Jean   Pierre ')).toBe('jean pierre');
  });

  it('renvoie une chaîne vide pour une entrée vide', () => {
    expect(normalizeName('   ')).toBe('');
  });

  it('conserve les caractères non latins sans les altérer', () => {
    expect(normalizeName('محمد')).toBe('محمد');
  });
});

describe('buildSearchName', () => {
  it('concatène nom puis prénom normalisés', () => {
    expect(buildSearchName('DIOP', 'Aïssatou')).toBe('diop aissatou');
  });
});

describe('toSearchPattern', () => {
  it('normalise le terme recherché', () => {
    expect(toSearchPattern('  Aïssa ')).toBe('aissa');
  });

  it('retire les jokers SQL pour éviter un ILIKE non voulu', () => {
    expect(toSearchPattern('di%op_\\')).toBe('diop');
  });
});

describe('buildSwappedSearchName (A4)', () => {
  it('inverse nom et prénom, normalisés', () => {
    expect(buildSwappedSearchName('DIOP', 'Aïssatou')).toBe('aissatou diop');
  });
});

describe('birthYearWindow (A4)', () => {
  it('couvre l’année ± 2 du 1er janvier au 31 décembre', () => {
    const { from, to } = birthYearWindow(new Date('1990-06-15T00:00:00Z'));
    expect(from.toISOString().slice(0, 10)).toBe('1988-01-01');
    expect(to.toISOString().slice(0, 10)).toBe('1992-12-31');
  });
});

describe('formatPatientFullName', () => {
  it('écrit « Prénom NOM » avec le nom de famille en majuscules', () => {
    expect(formatPatientFullName('Awa', 'Diop-Ndiaye')).toBe('Awa DIOP-NDIAYE');
    expect(formatPatientFullName('Aïssatou', 'Sène')).toBe('Aïssatou SÈNE');
  });
});

describe('normalizeNationalId', () => {
  it('retire espaces et tirets et met en majuscules', () => {
    expect(normalizeNationalId(' ab 123-45 ')).toBe('AB12345');
    expect(normalizeNationalId('A-B  1-2')).toBe('AB12');
  });
});
