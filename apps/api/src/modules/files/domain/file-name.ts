/** Longueur maximale d'un nom d'origine conservé (caractères). */
const MAX_NAME_LENGTH = 200;
const MAX_EXTENSION_LENGTH = 10;
const FALLBACK_NAME = 'document';
/** Caractères de contrôle, séparateurs bidirectionnels (renommage trompeur « gpj.exe ») et caractères interdits des systèmes de fichiers. */
// eslint-disable-next-line no-control-regex -- les caractères de contrôle sont précisément ce que l'on retire.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const FORBIDDEN_CHARACTERS = /[<>:"/\\|?*]/g;

/**
 * Nom d'origine assaini (docs/13 D8) : dernier segment de chemin, forme NFC, sans caractère de contrôle ni caractère
 * interdit, 200 caractères au plus (extension conservée). Stocké chiffré, jamais utilisé dans la clé d'objet.
 */
export function sanitizeFileName(raw: string | undefined): string {
  const lastSegment = (raw ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = lastSegment
    .normalize('NFC')
    .replace(CONTROL_CHARACTERS, '')
    .replace(FORBIDDEN_CHARACTERS, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  if (cleaned === '') return FALLBACK_NAME;
  if (cleaned.length <= MAX_NAME_LENGTH) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const extension = dot > 0 && cleaned.length - dot <= MAX_EXTENSION_LENGTH ? cleaned.slice(dot) : '';
  return cleaned.slice(0, MAX_NAME_LENGTH - extension.length) + extension;
}

/** Encodage RFC 5987 : `encodeURIComponent` laisse passer `'()*`, réservés dans `filename*`. */
function encodeExtended(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** `Content-Disposition: attachment` avec un repli ASCII et le nom exact en UTF-8 (RFC 6266). */
export function contentDispositionAttachment(fileName: string): string {
  const asciiFallback = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeExtended(fileName)}`;
}

/** Clé d'objet (docs/13 D8) : `t/{tenantId}/files/{yyyy}/{mm}/{fileId}`, mois UTC de création. */
export function objectKeyFor(tenantId: string, fileId: string, createdAt: Date): string {
  const year = createdAt.getUTCFullYear();
  const month = String(createdAt.getUTCMonth() + 1).padStart(2, '0');
  return `t/${tenantId}/files/${year}/${month}/${fileId}`;
}
