import { describe, expect, it } from 'vitest';
import { buildSearchBody } from './patient-search';

describe('buildSearchBody (C1)', () => {
  it('refuse une saisie vide', () => {
    expect(buildSearchBody('  ', 'SN')).toEqual({ ok: false, error: 'Saisissez un nom, un téléphone ou un numéro de dossier.' });
  });
  it('refuse une saisie textuelle trop courte', () => {
    expect(buildSearchBody('a', 'SN')).toEqual({ ok: false, error: 'Saisissez au moins 2 caractères.' });
  });
  it('refuse une saisie trop longue', () => {
    expect(buildSearchBody('a'.repeat(101), 'SN')).toMatchObject({ ok: false });
  });
  it('reconnaît un IPP (insensible à la casse)', () => {
    expect(buildSearchBody('p26-0004217', 'SN')).toEqual({ ok: true, body: { ipp: 'P26-0004217', limit: 20 } });
  });
  it('reconnaît un téléphone international', () => {
    expect(buildSearchBody('+221 77 123 45 67', 'CI')).toEqual({ ok: true, body: { phone: '+221771234567', limit: 20 } });
  });
  it('normalise un numéro local avec le pays du tenant', () => {
    expect(buildSearchBody('77 123 45 67', 'SN')).toEqual({ ok: true, body: { phone: '+221771234567', limit: 20 } });
  });
  it('signale un numéro local sans pays connu', () => {
    const result = buildSearchBody('77 123 45 67', 'ZZ');
    expect(result.ok).toBe(false);
  });
  it('traite un nombre court comme un texte', () => {
    expect(buildSearchBody('1234', 'SN')).toEqual({ ok: true, body: { q: '1234', limit: 20 } });
  });
  it('recherche par nom et transmet le curseur opaque', () => {
    expect(buildSearchBody('  Diallo ', 'SN', 'abc')).toEqual({ ok: true, body: { q: 'Diallo', limit: 20, cursor: 'abc' } });
  });
  it('ignore un curseur vide', () => {
    expect(buildSearchBody('Diallo', 'SN', '')).toEqual({ ok: true, body: { q: 'Diallo', limit: 20 } });
  });
  it('refuse un curseur démesuré', () => {
    expect(buildSearchBody('Diallo', 'SN', 'x'.repeat(500))).toMatchObject({ ok: false });
  });
});
