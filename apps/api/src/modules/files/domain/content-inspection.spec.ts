import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import {
  METADATA_MARKER,
  jpegWithExif,
  pdf,
  pdfWithCompressedJavaScript,
  pngWithMetadata,
  webpWithMetadata,
  windowsExecutable,
} from '../../../../test/files/samples';
import { inspectContent, pdfHasActiveContent, stripImageMetadata } from './content-inspection';
import { MAX_PDF_STREAMS } from './pdf-active-content';

const marker = Buffer.from(METADATA_MARKER);

/** Liste des chunks d'un PNG (type, CRC valide). */
function pngChunks(png: Buffer): { type: string; crcOk: boolean }[] {
  const chunks: { type: string; crcOk: boolean }[] = [];
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    const typed = png.subarray(offset + 4, offset + 8 + length);
    chunks.push({ type: typed.subarray(0, 4).toString('latin1'), crcOk: (crc32(typed) >>> 0) === png.readUInt32BE(offset + 8 + length) });
    offset += 12 + length;
  }
  return chunks;
}

describe('inspectContent (type réel, liste blanche, docs/13 D8)', () => {
  it.each([
    ['PDF', pdf(), 'application/pdf'],
    ['JPEG', jpegWithExif(), 'image/jpeg'],
    ['PNG', pngWithMetadata(), 'image/png'],
    ['WebP', webpWithMetadata(), 'image/webp'],
  ])('accepte un %s d’après son contenu', async (_label, content, mimeType) => {
    expect(await inspectContent(content)).toMatchObject({ ok: true, mimeType });
  });

  it('refuse un exécutable renommé en .pdf : le type déclaré ne fait pas foi', async () => {
    expect(await inspectContent(windowsExecutable())).toEqual({ ok: false, reason: 'type_not_allowed', mimeType: 'application/x-msdownload' });
  });

  it('refuse un contenu de type inconnu (texte brut, HTML)', async () => {
    expect(await inspectContent(Buffer.from('<html><script>alert(1)</script></html>'))).toEqual({
      ok: false,
      reason: 'type_not_allowed',
      mimeType: 'application/octet-stream',
    });
  });

  it('refuse un PDF à contenu actif', async () => {
    expect(await inspectContent(pdf('5 0 obj << /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >> endobj'))).toEqual({
      ok: false,
      reason: 'active_content',
      mimeType: 'application/pdf',
    });
  });

  it('refuse une image à la structure invalide (en-tête reconnu, segments tronqués)', async () => {
    expect(await inspectContent(pngWithMetadata().subarray(0, 40))).toEqual({ ok: false, reason: 'type_not_allowed', mimeType: 'image/png' });
  });

  it('retire les métadonnées des images acceptées et laisse le PDF intact', async () => {
    const image = await inspectContent(jpegWithExif());
    const document = await inspectContent(pdf());

    expect(image.ok && image.content.includes(marker)).toBe(false);
    expect(document.ok && document.content.equals(pdf())).toBe(true);
  });
});

/** PDF à un flux : `dictionary` complète le dictionnaire de l'objet (ex. `/Filter /FlateDecode`), `data` est le contenu brut du flux. */
function pdfWithStream(dictionary: string, data: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n4 0 obj << ${dictionary} /Length ${data.length} >>\nstream\n`, 'latin1'),
    data,
    Buffer.from('\nendstream\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF', 'latin1'),
  ]);
}

describe('pdfHasActiveContent', () => {
  it('ne signale rien sur un PDF ordinaire', () => {
    expect(pdfHasActiveContent(pdf())).toBe(false);
  });

  it.each([
    ['/JS', '<< /S /JavaScript /JS (x) >>'],
    ['/JavaScript seul', '<< /Names << /JavaScript 6 0 R >> >>'],
    ['nom échappé /J#53', '<< /J#53 (x) >>'],
    ['nom échappé /Java#53cript', '<< /Java#53cript 6 0 R >>'],
  ])('détecte %s', (_label, object) => {
    expect(pdfHasActiveContent(pdf(`5 0 obj ${object} endobj`))).toBe(true);
  });

  it('ne confond pas un nom voisin (/JSON, /JBIG2Decode) avec du JavaScript', () => {
    expect(pdfHasActiveContent(pdf('5 0 obj << /JSON (x) /Filter /JBIG2Decode >> endobj'))).toBe(false);
  });

  it('détecte le JavaScript caché dans un flux compressé (FlateDecode)', () => {
    expect(pdfHasActiveContent(pdfWithCompressedJavaScript())).toBe(true);
  });

  it('refuse un flux FlateDecode illisible (échec fermé)', () => {
    expect(pdfHasActiveContent(pdfWithStream('/Filter /FlateDecode', Buffer.from('not-zlib')))).toBe(true);
  });

  it('accepte un flux FlateDecode ordinaire et un flux brut sans filtre', () => {
    expect(pdfHasActiveContent(pdfWithStream('/Filter /FlateDecode', deflateSync(Buffer.from('BT (Bonjour) Tj ET'))))).toBe(false);
    expect(pdfHasActiveContent(pdfWithStream('', Buffer.from('BT (Bonjour) Tj ET')))).toBe(false);
  });

  it('refuse un flux dont la décompression dépasse la limite par flux', () => {
    const bomb = deflateSync(Buffer.alloc(33 * 1024 * 1024));

    expect(pdfHasActiveContent(pdfWithStream('/Filter /FlateDecode', bomb))).toBe(true);
  });

  it('refuse un document dont la décompression cumulée dépasse le budget', () => {
    const heavy = deflateSync(Buffer.alloc(30 * 1024 * 1024));
    const objects = [1, 2, 3].map((n) => `${n} 0 obj << /Filter /FlateDecode >>\nstream\n`);
    const body = Buffer.concat(objects.flatMap((head) => [Buffer.from(head, 'latin1'), heavy, Buffer.from('\nendstream\nendobj\n', 'latin1')]));

    expect(pdfHasActiveContent(Buffer.concat([Buffer.from('%PDF-1.7\n'), body]))).toBe(true);
  });

  it.each([
    ['ASCII85Decode', '/Filter /ASCII85Decode'],
    ['ASCIIHexDecode', '/Filter /ASCIIHexDecode'],
    ['LZWDecode', '/Filter /LZWDecode'],
    ['Crypt', '/Filter /Crypt'],
    ['chaîne de filtres', '/Filter [/ASCII85Decode /FlateDecode]'],
    ['chaîne Flate + image', '/Filter [/FlateDecode /DCTDecode]'],
    ['filtre nommé par échappement', '/Filter /ASCII#38#35Decode'],
    ['filtre en référence indirecte', '/Filter 9 0 R'],
  ])('refuse un flux au filtre non géré : %s', (_label, dictionary) => {
    expect(pdfHasActiveContent(pdfWithStream(dictionary, Buffer.from('données')))).toBe(true);
  });

  it.each(['DCTDecode', 'JPXDecode', 'CCITTFaxDecode', 'JBIG2Decode'])('accepte un flux d’image %s non décodé (scan)', (filter) => {
    expect(pdfHasActiveContent(pdfWithStream(`/Subtype /Image /Filter /${filter}`, randomBytes(512)))).toBe(false);
  });

  // Données compressées quasi aléatoires : `/JS ` y apparaît par hasard dans de gros scans, sans être un nom PDF.
  it('n’analyse pas les données d’une image comme du texte (pas de refus à tort d’un scan)', () => {
    const scan = Buffer.concat([randomBytes(256), Buffer.from('/JS /XFA ', 'latin1'), randomBytes(256)]);
    expect(pdfHasActiveContent(pdfWithStream('/Subtype /Image /Filter /DCTDecode', scan))).toBe(false);
  });

  it('n’analyse pas les octets compressés d’un flux Flate, seulement leur décompression', () => {
    const compressed = deflateSync(Buffer.from('BT /F1 12 Tf (Carte d’identité) Tj ET', 'latin1'));
    const withLookalike = Buffer.concat([compressed, Buffer.from('/JS ', 'latin1')]);
    // Octets ajoutés après la fin du flux zlib : ignorés par inflate, et jamais lus comme une structure PDF.
    expect(pdfHasActiveContent(pdfWithStream('/Filter /FlateDecode', withLookalike))).toBe(false);
  });

  it('refuse toujours un nom interdit dans un flux sans filtre (texte en clair)', () => {
    expect(pdfHasActiveContent(pdfWithStream('', Buffer.from('<< /S /JavaScript /JS (app.alert(1)) >>', 'latin1')))).toBe(true);
  });

  it('refuse toujours un nom interdit placé après le dernier flux', () => {
    const pdf = Buffer.concat([pdfWithStream('/Subtype /Image /Filter /DCTDecode', randomBytes(64)), Buffer.from('\n9 0 obj << /S /Launch >> endobj', 'latin1')]);
    expect(pdfHasActiveContent(pdf)).toBe(true);
  });

  it.each([
    ['/Encrypt', '<< /Root 1 0 R /Encrypt 7 0 R >>'],
    ['/Launch', '<< /S /Launch /F (cmd.exe) >>'],
    ['/EmbeddedFile', '<< /Type /EmbeddedFile >>'],
    ['/EmbeddedFiles', '<< /Names << /EmbeddedFiles 8 0 R >> >>'],
    ['/RichMedia', '<< /Subtype /RichMedia >>'],
    ['/XFA', '<< /XFA 9 0 R >>'],
    ['/Launch échappé', '<< /La#75nch (x) >>'],
  ])('refuse le nom %s', (_label, object) => {
    expect(pdfHasActiveContent(pdf(`5 0 obj ${object} endobj`))).toBe(true);
  });

  it('refuse un nom interdit caché dans un flux compressé', () => {
    expect(pdfHasActiveContent(pdfWithStream('/Filter /FlateDecode', deflateSync(Buffer.from('<< /S /Launch >>'))))).toBe(true);
  });

  it('accepte /OpenAction et /AA (PDF scannés légitimes)', () => {
    expect(pdfHasActiveContent(pdf('1 0 obj << /OpenAction [3 0 R /Fit] /AA << /O 4 0 R >> >> endobj'))).toBe(false);
  });

  it('refuse un flux jamais refermé (pas de endstream)', () => {
    expect(pdfHasActiveContent(Buffer.from('%PDF-1.7\n1 0 obj << >>\nstream\nabc', 'latin1'))).toBe(true);
  });

  it.each([
    ['sans endstream', '%PDF-1.7\n' + 'stream\n'.repeat(200_000), true],
    ['avec un seul endstream final (un flux brut)', '%PDF-1.7\n' + 'stream\n'.repeat(200_000) + 'endstream', false],
    ['flux vides enchaînés', '%PDF-1.7\n' + 'stream\nendstream\n'.repeat(100_000), true],
  ])('répond en moins d’une seconde au PDF pathologique « stream\\n » répété (1,4 Mo) %s', (_label, source, expected) => {
    const pathological = Buffer.from(source, 'latin1');
    const started = performance.now();

    const refused = pdfHasActiveContent(pathological);

    expect(performance.now() - started).toBeLessThan(1_000);
    expect(refused).toBe(expected);
  });

  it('refuse au-delà de 2 000 flux, en temps linéaire', () => {
    const many = Buffer.from('%PDF-1.7\n' + '1 0 obj << >>\nstream\nx\nendstream\nendobj\n'.repeat(MAX_PDF_STREAMS + 1), 'latin1');
    const accepted = Buffer.from('%PDF-1.7\n' + '1 0 obj << >>\nstream\nx\nendstream\nendobj\n'.repeat(MAX_PDF_STREAMS), 'latin1');
    const started = performance.now();

    expect(pdfHasActiveContent(many)).toBe(true);
    expect(pdfHasActiveContent(accepted)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('stripImageMetadata (retrait EXIF avant stockage)', () => {
  it('JPEG : retire APP1 (EXIF, XMP) et APP13 (IPTC), conserve JFIF, le profil ICC et les données d’image', () => {
    const source = jpegWithExif();
    const stripped = stripImageMetadata('image/jpeg', source);

    expect(stripped.includes(marker)).toBe(false);
    expect(stripped.includes(Buffer.from('JFIF'))).toBe(true);
    expect(stripped.includes(Buffer.from('ICC_PROFILE'))).toBe(true);
    expect(stripped.subarray(-7).equals(source.subarray(-7))).toBe(true);
    expect(stripped.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(true);
  });

  it('PNG : retire eXIf, tEXt, iTXt, zTXt et tIME, chunks restants intacts (CRC valides)', () => {
    const stripped = stripImageMetadata('image/png', pngWithMetadata());

    expect(stripped.includes(marker)).toBe(false);
    expect(pngChunks(stripped)).toEqual([
      { type: 'IHDR', crcOk: true },
      { type: 'IDAT', crcOk: true },
      { type: 'IEND', crcOk: true },
    ]);
  });

  it('WebP : retire EXIF et XMP, efface leurs drapeaux VP8X et recalcule la taille RIFF', () => {
    const stripped = stripImageMetadata('image/webp', webpWithMetadata());

    expect(stripped.includes(marker)).toBe(false);
    expect(stripped.readUInt32LE(4)).toBe(stripped.length - 8);
    const vp8xFlags = stripped[20]!;
    expect(vp8xFlags & 0x08).toBe(0);
    expect(vp8xFlags & 0x04).toBe(0);
    expect(vp8xFlags & 0x20).toBe(0x20);
    expect(stripped.includes(Buffer.from('VP8L'))).toBe(true);
  });

  it('laisse intact un contenu d’un autre type', () => {
    expect(stripImageMetadata('application/pdf', pdf()).equals(pdf())).toBe(true);
  });

  it('refuse une image à la structure invalide (segments tronqués)', () => {
    expect(() => stripImageMetadata('image/jpeg', jpegWithExif().subarray(0, 12))).toThrow(/structure/);
    expect(() => stripImageMetadata('image/png', pngWithMetadata().subarray(0, 20))).toThrow(/structure/);
    expect(() => stripImageMetadata('image/webp', webpWithMetadata().subarray(0, 25))).toThrow(/structure/);
  });
});
