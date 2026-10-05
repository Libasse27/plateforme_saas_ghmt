/** En-têtes dont la valeur est un secret ou une signature (jamais journalisés, même par un sérialiseur modifié ultérieurement). */
export const SENSITIVE_HEADERS = [
  'authorization',
  'cookie',
  'x-token',
  'x-sandbox-signature',
  'x-signature',
  'x-webhook-signature',
  'x-hub-signature',
  'x-hub-signature-256',
  'x-ghmt-signature',
  'x-api-key',
  'x-csrf-token',
] as const;

/** Chemins pino à masquer : en-têtes sensibles de la requête et cookies posés par la réponse. */
export const REDACTED_LOG_PATHS: readonly string[] = [...SENSITIVE_HEADERS.map((name) => `req.headers["${name}"]`), 'res.headers["set-cookie"]'];
