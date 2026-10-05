import { describe, expect, it } from 'vitest';
import { SMS_MAX_SEGMENTS, analyzeSms, transliterateForSms } from './sms-encoding';

describe('transliterateForSms', () => {
  it('conserve les caractères du jeu GSM-7 (é è à ù)', () => {
    expect(transliterateForSms('éèàù')).toBe('éèàù');
  });

  it('remplace les caractères hors GSM-7 par leur équivalent ASCII', () => {
    expect(transliterateForSms('Hôtel Dieu ç ê î ô û â œ')).toBe('Hotel Dieu c e i o u a oe');
  });

  it('normalise la ponctuation typographique et les espaces insécables', () => {
    expect(transliterateForSms('l’heure « 10h » – ok… !')).toBe('l\'heure " 10h " - ok... !');
  });

  it('laisse tel quel un caractère sans équivalent (l’encodage basculera en UCS-2)', () => {
    expect(transliterateForSms('Ok ✓')).toBe('Ok ✓');
  });
});

describe('analyzeSms : GSM-7', () => {
  it('compte un message GSM-7 de 160 caractères comme 1 segment', () => {
    const result = analyzeSms('a'.repeat(160), { transliterate: false });

    expect(result).toMatchObject({ encoding: 'GSM7', units: 160, segments: 1 });
  });

  it('passe à 2 segments de 153 au-delà de 160', () => {
    expect(analyzeSms('a'.repeat(161), { transliterate: false }).segments).toBe(2);
    expect(analyzeSms('a'.repeat(306), { transliterate: false }).segments).toBe(2);
    expect(analyzeSms('a'.repeat(307), { transliterate: false }).segments).toBe(3);
    expect(analyzeSms('a'.repeat(459), { transliterate: false }).segments).toBe(3);
    expect(analyzeSms('a'.repeat(460), { transliterate: false }).segments).toBe(4);
  });

  it('accepte é è à ù sans quitter le GSM-7', () => {
    expect(analyzeSms('Rendez-vous confirmé à 10h, où êtes-vous', { transliterate: false }).encoding).toBe('UCS2');
    expect(analyzeSms('é è à ù', { transliterate: false }).encoding).toBe('GSM7');
  });

  it('compte deux unités pour un caractère de la table d’extension (€, [, ])', () => {
    expect(analyzeSms('5€', { transliterate: false })).toMatchObject({ encoding: 'GSM7', units: 3 });
    expect(analyzeSms('[ok]', { transliterate: false }).units).toBe(6);
  });
});

describe('analyzeSms : UCS-2', () => {
  it('bascule en UCS-2 sur ê et ç sans translittération', () => {
    expect(analyzeSms('très bientôt', { transliterate: false }).encoding).toBe('UCS2');
    expect(analyzeSms('français', { transliterate: false }).encoding).toBe('UCS2');
  });

  it('segmente à 70 puis 67 caractères', () => {
    expect(analyzeSms('ê'.repeat(70), { transliterate: false })).toMatchObject({ encoding: 'UCS2', segments: 1 });
    expect(analyzeSms('ê'.repeat(71), { transliterate: false }).segments).toBe(2);
    expect(analyzeSms('ê'.repeat(134), { transliterate: false }).segments).toBe(2);
    expect(analyzeSms('ê'.repeat(135), { transliterate: false }).segments).toBe(3);
    expect(analyzeSms('ê'.repeat(202), { transliterate: false }).segments).toBe(4);
  });

  it('compte un emoji pour deux unités UTF-16', () => {
    expect(analyzeSms('😀', { transliterate: false })).toMatchObject({ encoding: 'UCS2', units: 2 });
  });
});

describe('analyzeSms : translittération', () => {
  it('reste en GSM-7 quand la translittération est active', () => {
    const result = analyzeSms('très bientôt, français', { transliterate: true });

    expect(result.encoding).toBe('GSM7');
    expect(result.text).toBe('très bientot, francais');
  });

  it('retourne le texte inchangé quand la translittération est désactivée', () => {
    expect(analyzeSms('français', { transliterate: false }).text).toBe('français');
  });

  it('garde l’UCS-2 pour un caractère sans équivalent même translittéré', () => {
    expect(analyzeSms('Ok ✓', { transliterate: true }).encoding).toBe('UCS2');
  });
});

describe('plafond de segments', () => {
  it('expose le plafond du contrat (3 segments)', () => {
    expect(SMS_MAX_SEGMENTS).toBe(3);
  });

  it('un texte vide ne compte aucun segment', () => {
    expect(analyzeSms('', { transliterate: true }).segments).toBe(0);
  });
});
