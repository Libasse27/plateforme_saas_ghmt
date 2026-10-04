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
  /** Fournisseur de paiement simulé (dev/tests) : actif par défaut hors production, interdit en production. */
  PAYMENTS_SANDBOX_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  PAYMENTS_ROUTES: paymentRoutes,
  /** CinetPay : l'adaptateur n'est actif que si clé API, identifiant de site, clé secrète et URL de notification sont fournis. */
  CINETPAY_API_KEY: optionalString,
  CINETPAY_SITE_ID: optionalString,
  CINETPAY_SECRET_KEY: optionalString,
  CINETPAY_BASE_URL: z.url().default('https://api-checkout.cinetpay.com/v2'),
  /** URL publique du webhook : https://<api>/api/v1/webhooks/payments/cinetpay */
  CINETPAY_NOTIFY_URL: optionalUrl,
  CINETPAY_RETURN_URL: optionalUrl,
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
  // Le simulateur de paiement ne doit jamais exister en production, même par erreur de configuration.
  if (source['NODE_ENV'] === 'production') {
    if (source['PAYMENTS_SANDBOX_ENABLED'] === 'true') {
      throw new Error('Configuration invalide : PAYMENTS_SANDBOX_ENABLED ne peut pas être activé en production.');
    }
    return Object.freeze({ ...result.data, PAYMENTS_SANDBOX_ENABLED: false });
  }
  return Object.freeze(result.data);
}
