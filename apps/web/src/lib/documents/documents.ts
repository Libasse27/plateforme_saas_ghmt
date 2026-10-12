import { ALLOWED_UPLOAD_TYPES, MAX_UPLOAD_BYTES, patientDocumentViewSchema, type FilePurpose, type PatientDocumentView } from '@ghmt/shared';
import type { ApiError } from '@/lib/api/errors';

/** Messages des documents (docs/13 §9), affichés tels quels à l'utilisateur. */
export const DOCUMENT_MESSAGES = {
  file_required: 'Choisissez un fichier à déposer.',
  file_too_large: 'Fichier trop volumineux (10 Mo au plus)',
  type_not_allowed: 'Type de fichier non accepté (PDF, JPEG, PNG, WebP)',
  active_content: 'Ce PDF contient du contenu actif (JavaScript) et a été refusé.',
  infected: 'Fichier refusé par l’analyse antivirus',
  storage_quota: 'Espace de stockage de votre abonnement atteint',
  storage_unavailable: 'Le stockage des documents est momentanément indisponible. Réessayez dans quelques minutes.',
  document_not_found: 'Ce document est introuvable ou n’est pas encore disponible.',
  patient_not_found: 'Patient introuvable.',
  some_unreadable: 'Certains documents ne peuvent pas être affichés.',
} as const;

export const PURPOSE_LABELS: Readonly<Record<FilePurpose, string>> = {
  identity: 'Pièce d’identité',
  insurance_card: 'Carte d’assurance',
  administrative: 'Justificatif administratif',
};

/** Attribut `accept` du champ de fichier (indicatif : le type réel est contrôlé par l'API). */
export const UPLOAD_ACCEPT = ALLOWED_UPLOAD_TYPES.join(',');

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  file_too_large: DOCUMENT_MESSAGES.file_too_large,
  type_not_allowed: DOCUMENT_MESSAGES.type_not_allowed,
  active_content: DOCUMENT_MESSAGES.active_content,
  infected: DOCUMENT_MESSAGES.infected,
  storage_unavailable: DOCUMENT_MESSAGES.storage_unavailable,
  document_not_found: DOCUMENT_MESSAGES.document_not_found,
  patient_not_found: DOCUMENT_MESSAGES.patient_not_found,
};

/** Message propre aux documents, ou `null` pour laisser le message commun (droits, session…). */
export function describeDocumentError(error: Pick<ApiError, 'code' | 'status'>): string | null {
  // Le seul quota contrôlé au dépôt d'un document est l'espace de stockage (docs/13 D6).
  if (error.code === 'plan_limit_reached') return DOCUMENT_MESSAGES.storage_quota;
  return ERROR_MESSAGES[error.code] ?? null;
}

/** Contrôle de taille avant envoi (navigateur et BFF) : la limite de l'API reste la seule qui fait foi. */
export function checkUploadFile(file: { readonly size: number } | null | undefined): string | null {
  if (!file || file.size === 0) return DOCUMENT_MESSAGES.file_required;
  if (file.size > MAX_UPLOAD_BYTES) return DOCUMENT_MESSAGES.file_too_large;
  return null;
}

export interface PatientDocumentsListing {
  readonly documents: PatientDocumentView[];
  /** Éléments de la réponse qui ne respectent pas le schéma : écartés, mais signalés à l'utilisateur. */
  readonly skipped: number;
}

export function toPatientDocuments(raw: unknown): PatientDocumentsListing {
  const items = (raw as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return { documents: [], skipped: 0 };
  const documents = items.flatMap((item) => {
    const parsed = patientDocumentViewSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
  return { documents, skipped: items.length - documents.length };
}

/** Téléchargement par le BFF (docs/13 D3) : jamais d'URL de stockage dans le HTML. */
export function documentContentHref(patientId: string, documentId: string): string {
  return `/patients/${encodeURIComponent(patientId)}/documents/${encodeURIComponent(documentId)}/contenu`;
}

const KIB = 1024;
const MIB = KIB * KIB;
const sizeFormat = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });

export function formatFileSize(bytes: number): string {
  if (bytes < KIB) return `${bytes} o`;
  if (bytes < MIB) return `${sizeFormat.format(bytes / KIB)} Ko`;
  return `${sizeFormat.format(bytes / MIB)} Mo`;
}

const ALLOWED_TYPES: ReadonlySet<string> = new Set(ALLOWED_UPLOAD_TYPES);
const DIGITS = /^\d+$/;

/**
 * En-têtes relayés au navigateur : type parmi la liste blanche (sinon neutre), toujours `attachment`, `nosniff`, `no-store`.
 * Aucun autre en-tête de l'API n'est transmis (cookies, en-têtes techniques).
 */
export function safeDownloadHeaders(upstream: Headers): Headers {
  const type = upstream.get('content-type') ?? '';
  const disposition = upstream.get('content-disposition') ?? '';
  const length = upstream.get('content-length') ?? '';
  const headers = new Headers({
    'content-type': ALLOWED_TYPES.has(type) ? type : 'application/octet-stream',
    'content-disposition': disposition.startsWith('attachment;') ? disposition : 'attachment',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  });
  if (DIGITS.test(length)) headers.set('content-length', length);
  return headers;
}
