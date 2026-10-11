import { Prisma } from '../../../generated/prisma/client';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Lots de suppression : au plus 5 000 lignes par table et par passe (docs/11 D16). */
export const PURGE_BATCH_SIZE = 5_000;

export interface PurgeRule {
  readonly table: string;
  /** Identifiant SQL de la table (constante interne, jamais une saisie). */
  readonly identifier: Prisma.Sql;
  readonly condition: (now: Date) => Prisma.Sql;
}

const before = (now: Date, days: number): Date => new Date(now.getTime() - days * DAY_MS);

/**
 * Seuils de purge (docs/11 D16). Les `sessions` portent leurs `refresh_tokens` et codes e-mail en cascade.
 * Les jetons de vérification d'inscription sont purgés par le job OPS.
 */
export const PURGE_RULES: readonly PurgeRule[] = [
  { table: 'refresh_tokens', identifier: Prisma.raw('tenant.refresh_tokens'), condition: (now) => Prisma.sql`expires_at < ${before(now, 1)}::timestamptz` },
  {
    table: 'sessions',
    identifier: Prisma.raw('tenant.sessions'),
    condition: (now) => Prisma.sql`(expires_at < ${before(now, 30)}::timestamptz OR revoked_at < ${before(now, 30)}::timestamptz)`,
  },
  { table: 'mfa_challenges', identifier: Prisma.raw('tenant.mfa_challenges'), condition: (now) => Prisma.sql`expires_at < ${before(now, 1)}::timestamptz` },
  { table: 'mfa_email_codes', identifier: Prisma.raw('tenant.mfa_email_codes'), condition: (now) => Prisma.sql`expires_at < ${before(now, 1)}::timestamptz` },
  {
    table: 'invitations',
    identifier: Prisma.raw('tenant.invitations'),
    condition: (now) => Prisma.sql`(consumed_at < ${before(now, 30)}::timestamptz OR expires_at < ${before(now, 30)}::timestamptz)`,
  },
  { table: 'password_reset_tokens', identifier: Prisma.raw('tenant.password_reset_tokens'), condition: (now) => Prisma.sql`expires_at < ${before(now, 1)}::timestamptz` },
];
