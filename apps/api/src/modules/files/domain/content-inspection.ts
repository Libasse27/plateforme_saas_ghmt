import { fileTypeFromBuffer } from 'file-type';
import { ALLOWED_UPLOAD_TYPES, type AllowedUploadType } from '@ghmt/shared';
import { InvalidImageStructureError, stripImageMetadata } from './image-metadata';
import { pdfHasActiveContent } from './pdf-active-content';

export { pdfHasActiveContent } from './pdf-active-content';
export { stripImageMetadata } from './image-metadata';

const UNKNOWN_TYPE = 'application/octet-stream';
const ALLOWED: ReadonlySet<string> = new Set(ALLOWED_UPLOAD_TYPES);

export type ContentRejection = 'type_not_allowed' | 'active_content';

export type ContentInspection =
  | { readonly ok: true; readonly mimeType: AllowedUploadType; readonly content: Buffer }
  | { readonly ok: false; readonly reason: ContentRejection; readonly mimeType: string };

function isAllowed(mimeType: string): mimeType is AllowedUploadType {
  return ALLOWED.has(mimeType);
}

/**
 * Contrôle du contenu déposé (docs/13 D8) : type réel détecté sur les octets (le type déclaré ne fait pas foi), liste
 * blanche PDF, JPEG, PNG, WebP, refus des PDF à JavaScript, métadonnées des images retirées. Renvoie le contenu à stocker.
 */
export async function inspectContent(content: Buffer): Promise<ContentInspection> {
  const mimeType = (await fileTypeFromBuffer(content))?.mime ?? UNKNOWN_TYPE;
  if (!isAllowed(mimeType)) return { ok: false, reason: 'type_not_allowed', mimeType };
  if (mimeType === 'application/pdf') {
    return pdfHasActiveContent(content) ? { ok: false, reason: 'active_content', mimeType } : { ok: true, mimeType, content };
  }
  try {
    return { ok: true, mimeType, content: stripImageMetadata(mimeType, content) };
  } catch (error) {
    if (error instanceof InvalidImageStructureError) return { ok: false, reason: 'type_not_allowed', mimeType };
    throw error;
  }
}
