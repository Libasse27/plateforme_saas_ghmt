/**
 * Retrait des métadonnées des images avant stockage (docs/13 D8) : EXIF (position GPS, appareil, date), XMP, IPTC et
 * commentaires. Réécriture structurelle sans décodage : les données d'image restent identiques octet pour octet.
 * Une structure invalide lève une erreur (le fichier est alors refusé comme type non accepté).
 */

const JPEG_SOI = 0xd8;
const JPEG_SOS = 0xda;
const JPEG_EOI = 0xd9;
/** APP1 (EXIF, XMP), APP13 (IPTC Photoshop), COM (commentaire). APP0 (JFIF), APP2 (ICC) et APP14 (Adobe) sont conservés. */
const JPEG_DROPPED_MARKERS: ReadonlySet<number> = new Set([0xe1, 0xed, 0xfe]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DROPPED_CHUNKS: ReadonlySet<string> = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);
const WEBP_DROPPED_CHUNKS: ReadonlySet<string> = new Set(['EXIF', 'XMP ']);
const VP8X_EXIF_FLAG = 0x08;
const VP8X_XMP_FLAG = 0x04;

export class InvalidImageStructureError extends Error {
  constructor(format: string) {
    super(`Image ${format} : structure invalide.`);
    this.name = 'InvalidImageStructureError';
  }
}

function isStandaloneJpegMarker(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

function stripJpeg(source: Buffer): Buffer {
  if (source.length < 4 || source[0] !== 0xff || source[1] !== JPEG_SOI) throw new InvalidImageStructureError('JPEG');
  const kept: Buffer[] = [source.subarray(0, 2)];
  let offset = 2;
  while (offset < source.length) {
    if (source[offset] !== 0xff) throw new InvalidImageStructureError('JPEG');
    let markerOffset = offset + 1;
    while (source[markerOffset] === 0xff) markerOffset += 1; // octets de remplissage
    const marker = source[markerOffset];
    if (marker === undefined) throw new InvalidImageStructureError('JPEG');
    if (marker === JPEG_SOS || marker === JPEG_EOI) {
      // Données d'image compressées jusqu'à la fin : recopiées telles quelles.
      kept.push(source.subarray(markerOffset - 1));
      return Buffer.concat(kept);
    }
    if (isStandaloneJpegMarker(marker)) {
      kept.push(source.subarray(markerOffset - 1, markerOffset + 1));
      offset = markerOffset + 1;
      continue;
    }
    if (markerOffset + 3 > source.length) throw new InvalidImageStructureError('JPEG');
    const end = markerOffset + 1 + source.readUInt16BE(markerOffset + 1);
    if (end > source.length) throw new InvalidImageStructureError('JPEG');
    if (!JPEG_DROPPED_MARKERS.has(marker)) kept.push(source.subarray(markerOffset - 1, end));
    offset = end;
  }
  return Buffer.concat(kept);
}

function stripPng(source: Buffer): Buffer {
  if (source.length < PNG_SIGNATURE.length || !source.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new InvalidImageStructureError('PNG');
  }
  const kept: Buffer[] = [PNG_SIGNATURE];
  let offset = PNG_SIGNATURE.length;
  while (offset < source.length) {
    if (offset + 12 > source.length) throw new InvalidImageStructureError('PNG');
    const end = offset + 12 + source.readUInt32BE(offset);
    if (end > source.length) throw new InvalidImageStructureError('PNG');
    const type = source.subarray(offset + 4, offset + 8).toString('latin1');
    if (!PNG_DROPPED_CHUNKS.has(type)) kept.push(source.subarray(offset, end));
    offset = end;
    if (type === 'IEND') break;
  }
  return Buffer.concat(kept);
}

function stripWebp(source: Buffer): Buffer {
  if (source.length < 12 || source.toString('latin1', 0, 4) !== 'RIFF' || source.toString('latin1', 8, 12) !== 'WEBP') {
    throw new InvalidImageStructureError('WebP');
  }
  const kept: Buffer[] = [];
  let offset = 12;
  while (offset < source.length) {
    if (offset + 8 > source.length) throw new InvalidImageStructureError('WebP');
    const fourcc = source.toString('latin1', offset, offset + 4);
    const size = source.readUInt32LE(offset + 4);
    const dataEnd = offset + 8 + size;
    if (dataEnd > source.length) throw new InvalidImageStructureError('WebP');
    const end = Math.min(dataEnd + (size % 2), source.length);
    if (fourcc === 'VP8X' && size >= 1) {
      const chunk = Buffer.from(source.subarray(offset, end));
      chunk[8] = chunk[8]! & ~(VP8X_EXIF_FLAG | VP8X_XMP_FLAG);
      kept.push(chunk);
    } else if (!WEBP_DROPPED_CHUNKS.has(fourcc)) {
      kept.push(source.subarray(offset, end));
    }
    offset = end;
  }
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...kept]);
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

/** Copie de l'image sans métadonnées ; tout autre type est renvoyé tel quel. */
export function stripImageMetadata(mimeType: string, content: Buffer): Buffer {
  switch (mimeType) {
    case 'image/jpeg':
      return stripJpeg(content);
    case 'image/png':
      return stripPng(content);
    case 'image/webp':
      return stripWebp(content);
    default:
      return content;
  }
}
