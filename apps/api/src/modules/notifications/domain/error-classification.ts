export type ErrorClass = 'transient' | 'permanent_recipient' | 'permanent_config';

export interface ClassifiedError {
  readonly errorClass: ErrorClass;
  /** Code court et sans donnée personnelle (jamais le message de l'erreur). */
  readonly errorCode: string;
}

const NETWORK_CODES: ReadonlySet<string> = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ESOCKET', 'ECONNECTION']);
const HTTP_PERMANENT_RECIPIENT: ReadonlySet<number> = new Set([400, 404, 422]);
const HTTP_PERMANENT_CONFIG: ReadonlySet<number> = new Set([401, 402, 403]);
const HTTP_SERVER_ERROR_MIN = 500;
const HTTP_SERVER_ERROR_MAX = 599;
const HTTP_SUCCESS_MIN = 200;
const HTTP_SUCCESS_MAX = 299;
const SMTP_TRANSIENT_MIN = 400;
const SMTP_PERMANENT_MIN = 500;
const SMTP_MAX = 599;

const transient = (errorCode: string): ClassifiedError => ({ errorClass: 'transient', errorCode });

/** SMTP : 4xx et erreurs réseau transitoires, 5xx permanentes (destinataire), reste transitoire. */
export function classifySmtpError(error: unknown): ClassifiedError {
  const source = typeof error === 'object' && error !== null ? (error as { responseCode?: unknown; code?: unknown }) : {};
  const { responseCode, code } = source;
  if (typeof responseCode === 'number') {
    if (responseCode >= SMTP_TRANSIENT_MIN && responseCode < SMTP_PERMANENT_MIN) return transient(`smtp_${responseCode}`);
    if (responseCode >= SMTP_PERMANENT_MIN && responseCode <= SMTP_MAX) return { errorClass: 'permanent_recipient', errorCode: `smtp_${responseCode}` };
  }
  if (typeof code === 'string' && NETWORK_CODES.has(code)) return transient(code);
  return transient('smtp_unknown');
}

/** Réponse HTTP d'un fournisseur SMS : `null` pour un succès (2xx), sinon la classe de l'échec (docs/10 §5.7). */
export function classifyHttpStatus(status: number): ClassifiedError | null {
  if (status >= HTTP_SUCCESS_MIN && status <= HTTP_SUCCESS_MAX) return null;
  const errorCode = `http_${status}`;
  if (HTTP_PERMANENT_RECIPIENT.has(status)) return { errorClass: 'permanent_recipient', errorCode };
  if (HTTP_PERMANENT_CONFIG.has(status)) return { errorClass: 'permanent_config', errorCode };
  if (status === 408 || status === 429 || (status >= HTTP_SERVER_ERROR_MIN && status <= HTTP_SERVER_ERROR_MAX)) return transient(errorCode);
  return transient(errorCode);
}

/** Erreur d'appel HTTP sortant (délai, réseau) : toujours transitoire. */
export function classifyNetworkError(error: unknown): ClassifiedError {
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
  return transient(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network_error');
}
