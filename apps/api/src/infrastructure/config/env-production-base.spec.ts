import { describe, expect, it } from 'vitest';
import { loadEnv } from './env';

// docs/13 §8 : documents (stockage S3, antivirus) et observabilité.
const BASE = {
  DATABASE_URL: 'postgresql://ghmt_app:x@localhost:5432/ghmt_test',
  PLATFORM_DATABASE_URL: 'postgresql://ghmt_platform:x@localhost:5432/ghmt_test',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
  JWT_ISSUER: 'https://api.ghmt.local',
  JWT_AUDIENCE: 'ghmt-api',
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  BLIND_INDEX_KEY: Buffer.alloc(32, 2).toString('base64'),
};
const PRODUCTION = {
  ...BASE,
  NODE_ENV: 'production',
  WEB_URL: 'https://app.ghmt.sn',
  TRUSTED_PROXIES: '10.0.0.0/8',
  JWT_PLATFORM_SECRET: 'p'.repeat(40),
  RATE_LIMIT_STORE: 'redis',
  REDIS_URL: 'redis://redis:6379/0',
};
const S3 = {
  FILES_ENABLED: 'true',
  S3_ENDPOINT: 'http://localhost:8333',
  S3_ACCESS_KEY_ID: 'ghmt-dev',
  S3_SECRET_ACCESS_KEY: 's'.repeat(20),
};

describe('loadEnv : documents (valeurs par défaut)', () => {
  it('désactive les documents et applique les défauts du contrat', () => {
    const env = loadEnv(BASE);

    expect(env.FILES_ENABLED).toBe(false);
    expect(env.S3_ENDPOINT).toBeUndefined();
    expect(env.S3_REGION).toBe('us-east-1');
    expect(env.S3_FORCE_PATH_STYLE).toBe(true);
    expect(env.S3_BUCKET_QUARANTINE).toBe('ghmt-dev-quarantine');
    expect(env.S3_BUCKET_DOCUMENTS).toBe('ghmt-dev-documents');
    expect(env.CLAMAV_HOST).toBeUndefined();
    expect(env.CLAMAV_PORT).toBe(3310);
  });

  it('traite les variables S3 vides comme absentes', () => {
    expect(loadEnv({ ...BASE, S3_ENDPOINT: '', S3_ACCESS_KEY_ID: '' }).S3_ENDPOINT).toBeUndefined();
  });
});

describe('loadEnv : stockage S3', () => {
  it('exige endpoint et identifiants quand FILES_ENABLED=true', () => {
    expect(() => loadEnv({ ...BASE, FILES_ENABLED: 'true' })).toThrow(/S3_ENDPOINT/);
    expect(() => loadEnv({ ...BASE, ...S3, S3_ACCESS_KEY_ID: '' })).toThrow(/S3_ACCESS_KEY_ID/);
    expect(() => loadEnv({ ...BASE, ...S3, S3_SECRET_ACCESS_KEY: '' })).toThrow(/S3_SECRET_ACCESS_KEY/);
    expect(loadEnv({ ...BASE, ...S3 }).FILES_ENABLED).toBe(true);
  });

  it('exige deux buckets distincts aux noms valides', () => {
    expect(() => loadEnv({ ...BASE, ...S3, S3_BUCKET_QUARANTINE: 'docs', S3_BUCKET_DOCUMENTS: 'docs' })).toThrow(/distincts/);
    expect(() => loadEnv({ ...BASE, S3_BUCKET_DOCUMENTS: 'Docs_Majuscules' })).toThrow(/S3_BUCKET_DOCUMENTS/);
  });

  it('accepte le style virtuel des URL sur demande', () => {
    expect(loadEnv({ ...BASE, S3_FORCE_PATH_STYLE: 'false' }).S3_FORCE_PATH_STYLE).toBe(false);
  });
});

describe('loadEnv : documents en production', () => {
  const productionFiles = { ...PRODUCTION, ...S3, S3_ENDPOINT: 'https://s3.cellule.example', CLAMAV_HOST: 'clamav' };

  it('impose https pour le stockage objet', () => {
    expect(() => loadEnv({ ...productionFiles, S3_ENDPOINT: 'http://s3.cellule.example' })).toThrow(/S3_ENDPOINT doit utiliser https/);
  });

  it('refuse les documents sans antivirus (docs/13 D5)', () => {
    expect(() => loadEnv({ ...productionFiles, CLAMAV_HOST: '' })).toThrow(/CLAMAV_HOST est requis/);
  });

  it('accepte une configuration complète', () => {
    const env = loadEnv(productionFiles);

    expect(env.FILES_ENABLED).toBe(true);
    expect(env.CLAMAV_HOST).toBe('clamav');
  });

  it("n'exige rien quand les documents sont désactivés", () => {
    expect(loadEnv(PRODUCTION).FILES_ENABLED).toBe(false);
  });
});

describe('loadEnv : observabilité', () => {
  it('applique les défauts du contrat', () => {
    const env = loadEnv(BASE);

    expect(env.OTEL_ENABLED).toBe(false);
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
    expect(env.OTEL_SERVICE_NAME).toBe('ghmt-api');
    expect(env.METRICS_PORT).toBe(9464);
    expect(env.METRICS_HOST).toBe('0.0.0.0');
  });

  it('accepte une adresse d’écoute des métriques (IP seulement)', () => {
    expect(loadEnv({ ...BASE, METRICS_HOST: '172.29.0.10' }).METRICS_HOST).toBe('172.29.0.10');
    expect(() => loadEnv({ ...BASE, METRICS_HOST: 'api.example' })).toThrow(/METRICS_HOST/);
  });

  it("exige l'endpoint OTLP quand OTEL_ENABLED=true", () => {
    expect(() => loadEnv({ ...BASE, OTEL_ENABLED: 'true' })).toThrow(/OTEL_EXPORTER_OTLP_ENDPOINT/);
    expect(loadEnv({ ...BASE, OTEL_ENABLED: 'true', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector:4318' }).OTEL_ENABLED).toBe(true);
  });

  it("refuse un port de métriques égal au port de l'API", () => {
    expect(() => loadEnv({ ...BASE, PORT: '9464' })).toThrow(/METRICS_PORT doit être distinct de PORT/);
    expect(() => loadEnv({ ...BASE, METRICS_PORT: '80000' })).toThrow(/METRICS_PORT/);
  });
});
