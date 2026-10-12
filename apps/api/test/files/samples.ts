import { crc32, deflateSync } from 'node:zlib';

/** Marqueur de métadonnées : ne doit jamais subsister dans un fichier retraité. */
export const METADATA_MARKER = 'GPS-14.6928N-17.4467W-NDIAYE';

/**
 * Signature de test antivirus EICAR (inoffensive), reconstituée à l'exécution : aucun fichier du dépôt ne la contient
 * telle quelle (les antivirus du poste de développement ne mettent pas le dépôt en quarantaine).
 */
export function eicar(): Buffer {
  const parts = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'];
  return Buffer.from(parts.join(''), 'latin1');
}

function segment(marker: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0xff00 | marker, 0);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

/** JPEG minimal : JFIF (APP0), EXIF (APP1) et IPTC (APP13) portant le marqueur, puis données d'image après SOS. */
export function jpegWithExif(): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from(METADATA_MARKER)])),
    segment(0xe2, Buffer.from('ICC_PROFILE\0profil', 'latin1')),
    segment(0xed, Buffer.from(`Photoshop 3.0\0${METADATA_MARKER}`, 'latin1')),
    segment(0xdb, Buffer.alloc(65, 1)),
    segment(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00])),
    Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd9]),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed) >>> 0, 0);
  return Buffer.concat([length, typed, crc]);
}

/** PNG 1×1 avec chunks de métadonnées (eXIf, tEXt, iTXt, zTXt, tIME). */
export function pngWithMetadata(): Buffer {
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('eXIf', Buffer.from(`MM\0*${METADATA_MARKER}`, 'latin1')),
    pngChunk('tEXt', Buffer.from(`Author\0${METADATA_MARKER}`, 'latin1')),
    pngChunk('iTXt', Buffer.from(`Comment\0\0\0\0\0${METADATA_MARKER}`, 'latin1')),
    pngChunk('zTXt', Buffer.concat([Buffer.from('Comment\0\0', 'latin1'), deflateSync(Buffer.from(METADATA_MARKER))])),
    pngChunk('tIME', Buffer.from([0x07, 0xea, 10, 11, 12, 0, 0])),
    pngChunk('IDAT', deflateSync(Buffer.from([0, 255, 255, 255, 255]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function riffChunk(fourcc: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(fourcc, 0, 'latin1');
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, data.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

/** WebP étendu (VP8X) avec drapeaux EXIF et XMP, chunks `EXIF` et `XMP ` (taille impaire : octet de bourrage). */
export function webpWithMetadata(): Buffer {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x08 | 0x04 | 0x20; // EXIF, XMP, ICC
  const body = Buffer.concat([
    Buffer.from('WEBP', 'latin1'),
    riffChunk('VP8X', vp8x),
    riffChunk('ICCP', Buffer.from('profil', 'latin1')),
    riffChunk('VP8L', Buffer.from([0x2f, 0x00, 0x00, 0x00, 0x00, 0x88, 0x88, 0x08])),
    riffChunk('EXIF', Buffer.from(`${METADATA_MARKER}!`, 'latin1')),
    riffChunk('XMP ', Buffer.from(`<x:xmpmeta>${METADATA_MARKER}</x:xmpmeta>`, 'latin1')),
  ]);
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

/** PDF minimal ; `extra` est inséré comme objet supplémentaire (ex. action JavaScript). */
export function pdf(extra = ''): Buffer {
  return Buffer.from(
    [
      '%PDF-1.7',
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
      '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
      '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj',
      extra,
      'trailer << /Root 1 0 R >>',
      '%%EOF',
    ].join('\n'),
    'latin1',
  );
}

/** PDF dont l'action JavaScript est cachée dans un flux compressé (FlateDecode), comme dans un flux d'objets. */
export function pdfWithCompressedJavaScript(): Buffer {
  const hidden = deflateSync(Buffer.from('<< /S /JavaScript /JS (app.alert(1)) >>', 'latin1'));
  return Buffer.concat([
    Buffer.from(`%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n4 0 obj << /Type /ObjStm /Filter /FlateDecode /Length ${hidden.length} >>\nstream\n`, 'latin1'),
    hidden,
    Buffer.from('\nendstream\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF', 'latin1'),
  ]);
}

/** Exécutable Windows (en-têtes MZ et PE) renommé en `.pdf` par l'utilisateur. */
export function windowsExecutable(): Buffer {
  const exe = Buffer.alloc(512);
  exe.write('MZ', 0, 'latin1');
  exe.writeUInt32LE(0x80, 0x3c);
  exe.write('PE\0\0', 0x80, 'latin1');
  return exe;
}
