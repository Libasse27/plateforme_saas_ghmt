/**
 * Stockage objet des tests de l'équipe DOC : SeaweedFS de développement (infra/docker-compose.yml, service `s3`),
 * buckets propres à ces suites. Les variables `S3_*` de l'environnement priment ; à défaut, les valeurs de
 * DÉVELOPPEMENT du compose (identiques à `.env.example`, jamais utilisées hors poste local ou CI).
 */
export interface TestStorageSettings {
  readonly endpoint: string;
  readonly region: string;
  readonly forcePathStyle: boolean;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly quarantineBucket: string;
  readonly documentsBucket: string;
}

const env = (name: string, fallback: string): string => {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
};

export function testStorageSettings(): TestStorageSettings {
  return {
    endpoint: env('S3_ENDPOINT', 'http://localhost:8333'),
    region: env('S3_REGION', 'us-east-1'),
    forcePathStyle: env('S3_FORCE_PATH_STYLE', 'true') === 'true',
    accessKeyId: env('S3_ACCESS_KEY_ID', 'ghmt-dev'),
    secretAccessKey: env('S3_SECRET_ACCESS_KEY', 'ghmt-dev-s3-secret'),
    quarantineBucket: env('S3_TEST_BUCKET_QUARANTINE', 'ghmt-test-doc-quarantine'),
    documentsBucket: env('S3_TEST_BUCKET_DOCUMENTS', 'ghmt-test-doc-documents'),
  };
}

/** Variables d'environnement de l'API pour les suites e2e des documents (FILES_ENABLED et S3 de test). */
export function testFilesEnv(): Record<string, string> {
  const s = testStorageSettings();
  return {
    FILES_ENABLED: 'true',
    S3_ENDPOINT: s.endpoint,
    S3_REGION: s.region,
    S3_FORCE_PATH_STYLE: String(s.forcePathStyle),
    S3_ACCESS_KEY_ID: s.accessKeyId,
    S3_SECRET_ACCESS_KEY: s.secretAccessKey,
    S3_BUCKET_QUARANTINE: s.quarantineBucket,
    S3_BUCKET_DOCUMENTS: s.documentsBucket,
  };
}
