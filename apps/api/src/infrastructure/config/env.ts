import { createHmac } from 'node:crypto';
import { z } from 'zod';

const KEY_BYTES = 32;
const base64Key = z
  .string()
  .refine((v) => Buffer.from(v, 'base64').length === KEY_BYTES, `clé de ${KEY_BYTES} octets encodée en base64 requise`);

/** Variable optionnelle : une valeur vide (modèle .env.example) équivaut à « non configurée ». */
const optionalString = z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().optional());
const optionalUrl = z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.url().optional());

/** Routage des paiements : clés `PAYS:DEVISE`, `DEVISE` ou `*` → fournisseurs par ordre de préférence (repli sur le suivant). */
const paymentRoutes = z
  .string()
  .default('')
  .transform((raw, ctx): Record<string, string[]> => {
    if (raw.trim() === '') return {};
    const parsed = z.record(z.string().min(1), z.array(z.string().min(1))).safeParse(safeJson(raw));
    if (!parsed.success) {
      ctx.addIssue({ code: 'custom', message: 'JSON attendu : {"SN:XOF":["cinetpay","sandbox"],"*":["sandbox"]}' });
      return z.NEVER;
    }
    return parsed.data;
  });

const DEFAULT_DUNNING_OFFSETS = '-7,-3,0,3,7,12,15';
const DUNNING_OFFSET_MIN = -30;
const DUNNING_OFFSET_MAX = 60;

/** Calendrier des relances SaaS : entiers (jours relatifs à l'échéance) triés, uniques, au moins un. Vide = défaut. */
const dunningOffsets = z
  .string()
  .default(DEFAULT_DUNNING_OFFSETS)
  .transform((raw, ctx): readonly number[] => {
    const source = raw.trim() === '' ? DEFAULT_DUNNING_OFFSETS : raw;
    const parts = source.split(',').map((part) => part.trim());
    const values = parts.map((part) => (/^-?\d+$/.test(part) ? Number(part) : Number.NaN));
    const valid =
      values.every((value) => Number.isInteger(value) && value >= DUNNING_OFFSET_MIN && value <= DUNNING_OFFSET_MAX) &&
      values.every((value, index) => index === 0 || value > (values[index - 1] ?? value));
    if (!valid) {
      ctx.addIssue({ code: 'custom', message: `entiers entre ${DUNNING_OFFSET_MIN} et ${DUNNING_OFFSET_MAX}, triés, sans doublon (ex. ${DEFAULT_DUNNING_OFFSETS})` });
      return z.NEVER;
    }
    return values;
  });

const booleanFlag = (defaultValue: 'true' | 'false') => z.enum(['true', 'false']).default(defaultValue).transform((v) => v === 'true');

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().startsWith('postgresql://'),
  /** Rôle ghmt_platform : schéma platform uniquement (console Super Administrateur, abonnements, paiements). */
  PLATFORM_DATABASE_URL: z.string().startsWith('postgresql://'),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET doit contenir au moins 32 caractères'),
  /** Secret des JWT du realm plateforme (≥ 32 caractères, distinct de JWT_ACCESS_SECRET et obligatoire en production). */
  JWT_PLATFORM_SECRET: optionalString.pipe(z.string().min(32, 'JWT_PLATFORM_SECRET doit contenir au moins 32 caractères').optional()),
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
  /** Fournisseur de paiement simulé (dev/tests) : INACTIF par défaut, à activer explicitement ; interdit en production. */
  PAYMENTS_SANDBOX_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  PAYMENTS_ROUTES: paymentRoutes,
  /** CinetPay : l'adaptateur n'est actif que si clé API, identifiant de site, clé secrète et URL de notification sont fournis. */
  CINETPAY_API_KEY: optionalString,
  CINETPAY_SITE_ID: optionalString,
  CINETPAY_SECRET_KEY: optionalString,
  CINETPAY_BASE_URL: z.url().default('https://api-checkout.cinetpay.com/v2'),
  /** URL publique du webhook : https://<api>/api/v1/webhooks/payments/cinetpay */
  CINETPAY_NOTIFY_URL: optionalUrl,
  CINETPAY_RETURN_URL: optionalUrl,
  /** Dispatcher et jobs de notification (docs/10 §8) : `false` en test (aucune tâche de fond). */
  NOTIFICATIONS_WORKER_ENABLED: booleanFlag('true'),
  NOTIFICATIONS_DISPATCH_INTERVAL_MS: z.coerce.number().int().min(2_000).max(300_000).default(10_000),
  NOTIFICATIONS_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  /** `none` : les SMS sont supprimés (provider_unavailable) avec repli e-mail ; `sandbox` interdit en production ; `http` exige URL et jeton. */
  SMS_PROVIDER: z.enum(['none', 'sandbox', 'http']).default('none'),
  /** Routes `/webhooks/sms/sandbox/*` (non signées) : enregistrées seulement si `true` (dev/test ; jamais en production). */
  SMS_SANDBOX_WEBHOOKS_ENABLED: booleanFlag('false'),
  SMS_SANDBOX_MAILBOX: z.email().default('sms-sandbox@ghmt.local'),
  SMS_HTTP_URL: optionalUrl,
  SMS_HTTP_TOKEN: optionalString.pipe(z.string().min(16, 'SMS_HTTP_TOKEN doit contenir au moins 16 caractères').optional()),
  SMS_HTTP_SENDER_ID: z.string().regex(/^[A-Za-z0-9]{3,11}$/, 'SMS_HTTP_SENDER_ID : 3 à 11 caractères alphanumériques').default('GHMT'),
  /** Sans secret, les webhooks de l'adaptateur `http` répondent 404. */
  SMS_HTTP_WEBHOOK_SECRET: optionalString.pipe(z.string().min(32, 'SMS_HTTP_WEBHOOK_SECRET doit contenir au moins 32 caractères').optional()),
  SMS_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(10_000),
  SAAS_DUNNING_OFFSETS_DAYS: dunningOffsets,
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

type ParsedEnv = z.infer<typeof envSchema>;
export type Env = Readonly<Omit<ParsedEnv, 'JWT_PLATFORM_SECRET'> & { JWT_PLATFORM_SECRET: string }>;

/** Hors production, un secret plateforme absent est dérivé du secret tenant (jamais identique) pour ne pas bloquer le développement. */
function derivePlatformSecret(accessSecret: string): string {
  return createHmac('sha256', accessSecret).update('ghmt:jwt:platform-realm').digest('base64url');
}

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
  const production = source['NODE_ENV'] === 'production';
  assertSmsConfiguration(result.data, production);
  const configured = result.data.JWT_PLATFORM_SECRET;
  if (production && !configured) throw new Error('Configuration invalide : JWT_PLATFORM_SECRET doit être défini en production.');
  if (production && configured === result.data.JWT_ACCESS_SECRET) {
    throw new Error('Configuration invalide : JWT_PLATFORM_SECRET doit être distinct de JWT_ACCESS_SECRET.');
  }
  const base = { ...result.data, JWT_PLATFORM_SECRET: configured ?? derivePlatformSecret(result.data.JWT_ACCESS_SECRET) };
  // Le simulateur de paiement ne doit jamais exister en production, même par erreur de configuration.
  if (production) {
    if (source['PAYMENTS_SANDBOX_ENABLED'] === 'true') {
      throw new Error('Configuration invalide : PAYMENTS_SANDBOX_ENABLED ne peut pas être activé en production.');
    }
    return Object.freeze({ ...base, PAYMENTS_SANDBOX_ENABLED: false });
  }
  return Object.freeze(base);
}

/** Cohérence du fournisseur SMS : `sandbox` interdit en production, `http` exige URL (https en production) et jeton. */
function assertSmsConfiguration(env: Pick<ParsedEnv, 'SMS_PROVIDER' | 'SMS_HTTP_URL' | 'SMS_HTTP_TOKEN'>, production: boolean): void {
  if (production && env.SMS_PROVIDER === 'sandbox') {
    throw new Error('Configuration invalide : SMS_PROVIDER=sandbox ne peut pas être utilisé en production.');
  }
  if (env.SMS_PROVIDER === 'http') {
    if (!env.SMS_HTTP_URL) throw new Error('Configuration invalide : SMS_HTTP_URL est requis avec SMS_PROVIDER=http.');
    if (!env.SMS_HTTP_TOKEN) throw new Error('Configuration invalide : SMS_HTTP_TOKEN est requis avec SMS_PROVIDER=http.');
  }
  if (production && env.SMS_HTTP_URL && !env.SMS_HTTP_URL.startsWith('https://')) {
    throw new Error('Configuration invalide : SMS_HTTP_URL doit utiliser https en production.');
  }
}
