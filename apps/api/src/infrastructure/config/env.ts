import { z } from 'zod';

const KEY_BYTES = 32;
const base64Key = z
  .string()
  .refine((v) => Buffer.from(v, 'base64').length === KEY_BYTES, `clé de ${KEY_BYTES} octets encodée en base64 requise`);

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().startsWith('postgresql://'),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET doit contenir au moins 32 caractères'),
  JWT_ISSUER: z.string().min(1),
  JWT_AUDIENCE: z.string().min(1),
  DATA_ENCRYPTION_KEY: base64Key,
  BLIND_INDEX_KEY: base64Key,
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((s) => s.split(',').map((o) => o.trim()).filter(Boolean)),
  /** Proxys de confiance (CIDR, séparés par des virgules ou mots-clés Express : loopback…) pour X-Forwarded-For. */
  TRUSTED_PROXIES: z
    .string()
    .default('loopback')
    .transform((s) => s.split(',').map((p) => p.trim()).filter(Boolean)),
  /** URL publique de l'application web (liens des e-mails d'invitation). */
  WEB_URL: z.url().default('http://localhost:3001'),
  SMTP_HOST: z.string().min(1).default('localhost'),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
  MAIL_FROM: z.string().min(3).default('GHMT <no-reply@ghmt.local>'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Env = Readonly<z.infer<typeof envSchema>>;

/** Jeton d'injection de la configuration validée. */
export const ENV = Symbol('ENV');

/** Valide l'environnement au démarrage : échoue immédiatement si un secret manque (fail fast). */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // En production, la liste des proxys de confiance doit être explicite : avec le défaut `loopback`,
  // un BFF hors de la machine ferait partager un seul quota de débit à tous les utilisateurs.
  if (source['NODE_ENV'] === 'production' && !source['TRUSTED_PROXIES']?.trim()) {
    throw new Error('Configuration invalide : TRUSTED_PROXIES doit être défini explicitement en production (adresses du BFF et des proxys).');
  }
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Configuration invalide : ${issues}`);
  }
  return Object.freeze(result.data);
}
