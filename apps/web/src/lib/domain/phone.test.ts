import { describe, expect, it } from 'vitest';
import { normalizePhone } from './phone';

interface Case {
  readonly country: string;
  readonly local: string;
  readonly international: string;
  readonly e164: string;
  readonly invalid: readonly string[];
}

const CASES: readonly Case[] = [
  { country: 'SN', local: '77 123 45 67', international: '+221 77 123 45 67', e164: '+221771234567', invalid: ['12345678', '77 123 45'] },
  { country: 'CI', local: '07 12 34 56 78', international: '+225 07 12 34 56 78', e164: '+2250712345678', invalid: ['07123456', '71 23 45 67'] },
  { country: 'CM', local: '6 77 12 34 56', international: '+237 677 123 456', e164: '+237677123456', invalid: ['6771234', '12'] },
  { country: 'CD', local: '0812345678', international: '+243 812 345 678', e164: '+243812345678', invalid: ['08123', '0012'] },
  { country: 'BJ', local: '01 97 12 34 56', international: '+229 01 97 12 34 56', e164: '+2290197123456', invalid: ['97123456', '0197'] },
  { country: 'TG', local: '90 12 34 56', international: '+228 90 12 34 56', e164: '+22890123456', invalid: ['901234', '9012345678'] },
  { country: 'BF', local: '70 12 34 56', international: '+226 70 12 34 56', e164: '+22670123456', invalid: ['701234', '7012345678'] },
  { country: 'ML', local: '76 12 34 56', international: '+223 76 12 34 56', e164: '+22376123456', invalid: ['761234', '7612345678'] },
  { country: 'GA', local: '06 12 34 56', international: '+241 06 12 34 56', e164: '+24106123456', invalid: ['0612', '06123456789'] },
  { country: 'NE', local: '90 12 34 56', international: '+227 90 12 34 56', e164: '+22790123456', invalid: ['901234', '9012345678'] },
  { country: 'GN', local: '622 12 34 56', international: '+224 622 12 34 56', e164: '+224622123456', invalid: ['6221234', '62212345678'] },
  { country: 'CG', local: '06 123 4567', international: '+242 06 123 4567', e164: '+242061234567', invalid: ['0612', '06123456789'] },
  { country: 'FR', local: '06 12 34 56 78', international: '+33 6 12 34 56 78', e164: '+33612345678', invalid: ['06 12 34', '0612345678901'] },
];

describe.each(CASES)('normalizePhone $country', ({ country, local, international, e164, invalid }) => {
  it('accepte le format local', () => {
    expect(normalizePhone(local, country)).toEqual({ ok: true, e164 });
  });
  it('accepte le format international (+)', () => {
    expect(normalizePhone(international, country)).toEqual({ ok: true, e164 });
  });
  it('accepte le préfixe 00', () => {
    expect(normalizePhone(international.replace('+', '00'), country)).toEqual({ ok: true, e164 });
  });
  it.each(invalid)('refuse le numéro invalide %s sans inventer de E.164', (value) => {
    const result = normalizePhone(value, country);
    expect(result).toEqual({ ok: false, error: expect.stringContaining('Numéro de téléphone invalide') });
  });
});

describe('normalizePhone cas particuliers', () => {
  it('détecte l\'indicatif déjà présent sans « + » (pas de double indicatif)', () => {
    expect(normalizePhone('221771234567', 'SN')).toEqual({ ok: true, e164: '+221771234567' });
    expect(normalizePhone('2250712345678', 'CI')).toEqual({ ok: true, e164: '+2250712345678' });
  });
  it('refuse un ancien numéro ivoirien à 8 chiffres', () => {
    expect(normalizePhone('07 12 34 56', 'CI').ok).toBe(false);
    expect(normalizePhone('+225 07 12 34 56', 'CI').ok).toBe(false);
  });
  it('accepte un numéro international d\'un autre pays que le tenant', () => {
    expect(normalizePhone('+221 77 123 45 67', 'CI')).toEqual({ ok: true, e164: '+221771234567' });
    expect(normalizePhone('00221 77 123 45 67', 'FR')).toEqual({ ok: true, e164: '+221771234567' });
  });
  it('refuse un numéro local d\'un autre pays (valide ailleurs seulement)', () => {
    expect(normalizePhone('06 12 34 56 78', 'SN').ok).toBe(false);
  });
  it('accepte la casse minuscule du pays', () => {
    expect(normalizePhone('77 123 45 67', 'sn')).toEqual({ ok: true, e164: '+221771234567' });
  });
  it('refuse un numéro local si le pays est inconnu ou absent', () => {
    expect(normalizePhone('77123456', 'ZZ')).toMatchObject({ ok: false });
    expect(normalizePhone('77123456', undefined)).toMatchObject({ ok: false });
  });
  it('refuse les caractères non téléphoniques et les longueurs absurdes', () => {
    for (const bad of ['abc', '+12', '1'.repeat(30), '', '   ', '+', '++221771234567']) {
      expect(normalizePhone(bad, 'SN')).toMatchObject({ ok: false });
    }
  });
});
