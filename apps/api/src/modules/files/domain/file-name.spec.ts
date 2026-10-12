import { describe, expect, it } from 'vitest';
import { contentDispositionAttachment, objectKeyFor, sanitizeFileName } from './file-name';

describe('sanitizeFileName (nom d’origine assaini, docs/13 D8)', () => {
  it('conserve un nom ordinaire, accents compris (forme NFC)', () => {
    expect(sanitizeFileName('Carte d’identité.pdf')).toBe('Carte d’identité.pdf');
    expect(sanitizeFileName('Cafe\u0301.png')).toBe('Café.png');
  });

  it('retire les chemins, caractères de contrôle et caractères interdits', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('C:\\Users\\fatou\\scan.jpg')).toBe('scan.jpg');
    expect(sanitizeFileName('a\u0000b\u001fc\u202e.pdf')).toBe('abc.pdf');
    expect(sanitizeFileName('rapport <final>?:*|".pdf')).toBe('rapport _final______.pdf');
  });

  it('réduit les blancs, retire points et blancs de bord, et remplace un nom vide', () => {
    expect(sanitizeFileName('  mon    scan  .pdf ')).toBe('mon scan .pdf');
    expect(sanitizeFileName('...')).toBe('document');
    expect(sanitizeFileName('')).toBe('document');
    expect(sanitizeFileName(undefined)).toBe('document');
  });

  it('tronque un nom trop long en conservant l’extension', () => {
    const name = sanitizeFileName(`${'a'.repeat(300)}.pdf`);

    expect(name).toHaveLength(200);
    expect(name.endsWith('.pdf')).toBe(true);
  });
});

describe('contentDispositionAttachment', () => {
  it('produit un attachment avec repli ASCII et nom UTF-8 encodé (RFC 6266 / 5987)', () => {
    expect(contentDispositionAttachment('Carte d’identité.pdf')).toBe(
      `attachment; filename="Carte d_identit_.pdf"; filename*=UTF-8''Carte%20d%E2%80%99identit%C3%A9.pdf`,
    );
  });

  it('échappe les caractères réservés de l’encodage étendu', () => {
    expect(contentDispositionAttachment("l'acte (1).pdf")).toBe(`attachment; filename="l'acte (1).pdf"; filename*=UTF-8''l%27acte%20%281%29.pdf`);
  });
});

describe('objectKeyFor (clé d’objet sans nom ni donnée patient)', () => {
  it('suit le gabarit t/{tenantId}/files/{yyyy}/{mm}/{fileId} en UTC', () => {
    expect(objectKeyFor('tenant-1', 'file-1', new Date('2026-01-31T23:30:00Z'))).toBe('t/tenant-1/files/2026/01/file-1');
  });
});
