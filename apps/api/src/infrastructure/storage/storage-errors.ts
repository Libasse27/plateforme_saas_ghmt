/** Objet absent du bucket (clé inconnue ou déjà supprimée). */
export class ObjectNotFoundError extends Error {
  constructor(readonly bucket: string, readonly key: string) {
    super('Objet introuvable dans le stockage.');
    this.name = 'ObjectNotFoundError';
  }
}

/**
 * Stockage objet injoignable ou en erreur (réseau, délai, 5xx, identifiants refusés) : l'API répond
 * 503 `storage_unavailable`. La cause est conservée pour le diagnostic, jamais renvoyée au client.
 */
export class StorageUnavailableError extends Error {
  constructor(readonly operation: string, options?: { cause?: unknown }) {
    super(`Stockage objet indisponible (${operation}).`, options);
    this.name = 'StorageUnavailableError';
  }
}
