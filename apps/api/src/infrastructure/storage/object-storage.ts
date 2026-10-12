import type { Readable } from 'node:stream';

/** Jeton d'injection du stockage objet (docs/13 D2) : l'implémentation S3 est fournie par l'équipe DOC. */
export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

/** Métadonnées d'un objet écrit : jamais de nom de fichier ni de donnée patient dans la clé. */
export interface StoredObject {
  readonly bucket: string;
  readonly key: string;
  readonly sizeBytes: number;
}

/** Contrat minimal de l'API S3 utilisé par GHMT : le code métier ne dépend d'aucun fournisseur. */
export interface ObjectStorage {
  put(bucket: string, key: string, body: Buffer | Readable, sizeBytes: number): Promise<StoredObject>;
  get(bucket: string, key: string): Promise<Readable>;
  copy(source: { readonly bucket: string; readonly key: string }, target: { readonly bucket: string; readonly key: string }): Promise<void>;
  delete(bucket: string, key: string): Promise<void>;
  /** Sonde de `/health/ready` : `false` si le stockage est injoignable. */
  isReachable(): Promise<boolean>;
}
